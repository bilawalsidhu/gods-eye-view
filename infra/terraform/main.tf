data "azurerm_resource_group" "this" {
  name = var.resource_group_name
}

data "azurerm_client_config" "current" {}

# Suffix for globally-unique names (ACR name, Key Vault name, web app hostname).
resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

resource "azurerm_container_registry" "acr" {
  name                = "${var.name_prefix}acr${random_string.suffix.result}"
  resource_group_name = data.azurerm_resource_group.this.name
  location            = data.azurerm_resource_group.this.location
  sku                 = var.acr_sku
  admin_enabled       = false
}

resource "azurerm_service_plan" "plan" {
  name                = "${var.name_prefix}-plan"
  resource_group_name = data.azurerm_resource_group.this.name
  location            = data.azurerm_resource_group.this.location
  os_type             = "Linux"
  sku_name            = var.app_service_plan_sku
}

# --- Secrets -----------------------------------------------------------
# Provider keys live ONLY in this vault. Terraform creates the vault and the
# app-setting references to it, never the secret values: a human sets each one
# out-of-band (`az keyvault secret set`, see terraform.tfvars.example), so no
# key ever passes through tfvars, plan output or state.
resource "azurerm_key_vault" "kv" {
  name                       = "${var.name_prefix}-kv-${random_string.suffix.result}"
  resource_group_name        = data.azurerm_resource_group.this.name
  location                   = data.azurerm_resource_group.this.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = true
  soft_delete_retention_days = var.key_vault_soft_delete_retention_days
}

# The web app reads secrets through its system-assigned identity.
resource "azurerm_role_assignment" "kv_secrets_user" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_linux_web_app.app.identity[0].principal_id
}

# Whoever runs `terraform apply` may set/rotate secret values afterwards.
resource "azurerm_role_assignment" "kv_secrets_officer" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

locals {
  # Matches the repo's Dockerfile (build/vite.js): vite preview binds here.
  base_app_settings = {
    HOST          = "0.0.0.0"
    PORT          = "8080"
    WEBSITES_PORT = "8080"

    # Per-client-IP caps for the cost-bearing proxies (OpenAI Realtime token,
    # HUD summary — separate buckets — and Google Places + Street View). The
    # code defaults to unlimited for local use; a public deployment must not.
    # "0" disables a cap.
    GEV_RATELIMIT_OPENAI_PER_MIN = tostring(var.ratelimit_openai_per_min)
    GEV_RATELIMIT_HUD_PER_MIN    = tostring(var.ratelimit_hud_per_min)
    GEV_RATELIMIT_GOOGLE_PER_MIN = tostring(var.ratelimit_google_per_min)
  }

  # App setting NAME -> Key Vault reference. Only names listed in
  # var.key_vault_secrets are wired: a reference to a secret that does not
  # exist yet would surface to the app as the literal "@Microsoft.KeyVault(...)"
  # string, which the providers would mistake for a configured key.
  secret_app_settings = {
    for name in var.key_vault_secrets :
    name => "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.kv.name};SecretName=${lower(replace(name, "_", "-"))})"
  }

  app_settings = merge(local.base_app_settings, local.secret_app_settings, var.app_settings_extra)

  # Free (F1) and Shared (D1) tiers reject `always_on = true` at apply time.
  always_on = !contains(["F1", "D1"], upper(var.app_service_plan_sku))

  ip_restricted = length(var.allowed_ip_ranges) > 0
}

resource "azurerm_linux_web_app" "app" {
  name                = "${var.name_prefix}-${random_string.suffix.result}"
  resource_group_name = data.azurerm_resource_group.this.name
  location            = data.azurerm_resource_group.this.location
  service_plan_id     = azurerm_service_plan.plan.id

  https_only = true

  # Deployment is image-pull only (managed identity); no FTP / Web Deploy
  # publishing credentials should exist.
  ftp_publish_basic_authentication_enabled       = false
  webdeploy_publish_basic_authentication_enabled = false

  identity {
    type = "SystemAssigned"
  }

  site_config {
    always_on                               = local.always_on
    container_registry_use_managed_identity = true
    minimum_tls_version                     = "1.2"
    scm_minimum_tls_version                 = "1.2"
    ftps_state                              = "Disabled"

    # Optional allowlist. Empty (default) leaves the site public; any entry
    # flips the default action to Deny so only the listed ranges get in. The
    # SCM (Kudu) site follows the same rules.
    ip_restriction_default_action = local.ip_restricted ? "Deny" : "Allow"
    scm_use_main_ip_restriction   = true

    dynamic "ip_restriction" {
      for_each = var.allowed_ip_ranges
      content {
        name       = "allow-${ip_restriction.key}"
        ip_address = ip_restriction.value
        action     = "Allow"
        priority   = 100 + ip_restriction.key
      }
    }

    application_stack {
      docker_image_name   = "${var.name_prefix}:${var.image_tag}"
      docker_registry_url = "https://${azurerm_container_registry.acr.login_server}"
    }
  }

  app_settings = local.app_settings

  lifecycle {
    # A CI/CD pipeline pushing new tags via `az webapp config container set`
    # (or the ACR webhook / continuous deployment) shouldn't be reverted by
    # the next `terraform apply`. Remove this if Terraform should own the tag.
    ignore_changes = [
      site_config[0].application_stack[0].docker_image_name,
    ]
  }
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.acr.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_linux_web_app.app.identity[0].principal_id
}
