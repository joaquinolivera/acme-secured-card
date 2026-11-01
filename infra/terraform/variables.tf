variable "region" {
  type    = string
  default = "us-east-1"
}
variable "environment" {
  type    = string
  default = "staging"
}
variable "image" {
  description = "Container image URI (ECR) built from the Dockerfile, pinned by digest or immutable tag"
  type        = string
}
variable "certificate_arn" {
  description = "ACM certificate for the HTTPS listener"
  type        = string
}
variable "desired_count" {
  type    = number
  default = 2
}
variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
