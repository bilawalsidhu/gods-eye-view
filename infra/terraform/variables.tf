variable "subscription_id" {
  description = "Azure subscription to deploy into. Leave null to use the ARM_SUBSCRIPTION_ID environment variable (or set it in terraform.tfvars)."
  type        = string
  default     = null
}

variable "resource_group_name" {
  description = "Existing resource group to deploy into. Not created by this config."
  type        = string
  default     = "rg-osint-demo"
}

variable "name_prefix" {
  description = "Short prefix used to name/derive all resource names (ACR, plan, Key Vault, web app). Lowercase letters/digits; keep it short (Key Vault names cap at 24 chars)."
  type        = string
  default     = "gev"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{0,9}$", var.name_prefix))
    error_message = "name_prefix must be 1-10 lowercase letters/digits, starting with a letter."
  }
}

variable "acr_sku" {
  description = "Azure Container Registry SKU."
  type        = string
  default     = "Basic"
}

variable "app_service_plan_sku" {
  description = "App Service Plan SKU (Linux). B1 is the cheapest tier with always-on support."
  type        = string
  default     = "B1"
}

variable "image_tag" {
  description = "Container image tag to deploy from ACR (repository is always named after name_prefix)."
  type        = string
  default     = "latest"
}

# --- Secrets -----------------------------------------------------------
# No secret VALUE is ever a Terraform variable. Values are set out-of-band in
# the Key Vault this config creates (see terraform.tfvars.example); Terraform
# only wires app settings to them by name.

variable "key_vault_secrets" {
  description = "App setting names (e.g. OPENAI_API_KEY) to wire as Key Vault references. Each maps to the secret named lower-case with dashes (OPENAI_API_KEY -> openai-api-key). Add a name ONLY after its secret exists in the vault; an unresolved reference reaches the app as a non-empty bogus value."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for name in var.key_vault_secrets : can(regex("^[A-Z][A-Z0-9_]*$", name))])
    error_message = "key_vault_secrets entries must be upper-case app setting names (A-Z, 0-9, _)."
  }
}

variable "key_vault_soft_delete_retention_days" {
  description = "Soft-delete retention for the Key Vault (7-90). Purge protection is always on, so a destroyed vault's name stays reserved for this long."
  type        = number
  default     = 7
}

# --- Abuse limits ------------------------------------------------------

variable "ratelimit_openai_per_min" {
  description = "GEV_RATELIMIT_OPENAI_PER_MIN: requests/min per client IP to the OpenAI Realtime token endpoint (voice). 0 = unlimited."
  type        = number
  default     = 3
}

variable "ratelimit_hud_per_min" {
  description = "GEV_RATELIMIT_HUD_PER_MIN: requests/min per client IP to the OpenAI HUD summary endpoint. A separate bucket from the voice token, so HUD polling cannot starve the mic. 0 = unlimited."
  type        = number
  default     = 6
}

variable "ratelimit_google_per_min" {
  description = "GEV_RATELIMIT_GOOGLE_PER_MIN: requests/min per client IP to the Google cost endpoints (Places, CCTV Street View fallback). 0 = unlimited."
  type        = number
  default     = 60
}

variable "allowed_ip_ranges" {
  description = "Optional CIDR allowlist for the site (and its SCM endpoint), e.g. [\"203.0.113.0/24\"]. Empty (default) = public; any entry denies everything else."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.allowed_ip_ranges : can(cidrhost(cidr, 0))])
    error_message = "allowed_ip_ranges entries must be CIDR blocks, e.g. 203.0.113.7/32."
  }
}

variable "app_settings_extra" {
  description = "Any additional NON-SECRET app settings (e.g. CCTV_* toggles, OPENAI_REALTIME_MODEL overrides, GEV_ALLOWED_HOSTS for a custom domain). Merged on top of the built-in settings, so entries here win on conflict. Never put a key here: it would land in state."
  type        = map(string)
  default     = {}
}
