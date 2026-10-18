terraform {
  required_version = ">= 1.6"

  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

module "naming" {
  source      = "../../modules/naming"
  environment = "production"
}

resource "random_pet" "bucket" {
  prefix = module.naming.prefix
}

output "bucket_name" {
  description = "The name the production bucket is created under."
  value       = random_pet.bucket.id
}
