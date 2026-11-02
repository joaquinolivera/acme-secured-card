terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.60" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Production: remote state (S3 + DynamoDB lock), e.g.
  # backend "s3" { bucket = "acme-tfstate" key = "secured-card/terraform.tfstate" region = "us-east-1" dynamodb_table = "acme-tflock" encrypt = true }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Service = "secured-card", Environment = var.environment, ManagedBy = "terraform" } }
}
