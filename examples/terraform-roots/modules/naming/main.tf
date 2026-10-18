terraform {
  required_version = ">= 1.6"
}

variable "environment" {
  description = "The environment a name belongs to."
  type        = string
}

locals {
  prefix = "shop-${var.environment}"
}

output "prefix" {
  description = "The prefix every resource name in the environment starts with."
  value       = local.prefix
}
