output "acr_login_server" {
  value = azurerm_container_registry.acr.login_server
}

output "acr_name" {
  value = azurerm_container_registry.acr.name
}

output "web_app_name" {
  value = azurerm_linux_web_app.app.name
}

output "web_app_url" {
  value = "https://${azurerm_linux_web_app.app.default_hostname}"
}

output "web_app_principal_id" {
  description = "System-assigned identity of the web app. Already granted AcrPull on the registry and Key Vault Secrets User on the vault; reuse this for any other role assignments."
  value       = azurerm_linux_web_app.app.identity[0].principal_id
}

output "key_vault_name" {
  description = "Key Vault holding the provider keys. Set values with `az keyvault secret set --vault-name <this> ...`, then list the app setting names in key_vault_secrets."
  value       = azurerm_key_vault.kv.name
}
