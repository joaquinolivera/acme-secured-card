resource "aws_kms_key" "data" {
  description         = "${local.name} data encryption"
  enable_key_rotation = true
}

resource "random_password" "db" {
  length  = 32
  special = false
}
resource "random_password" "jwt" {
  length  = 48
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "main" {
  identifier                      = local.name
  engine                          = "postgres"
  engine_version                  = "16"
  instance_class                  = var.db_instance_class
  allocated_storage               = 50
  max_allocated_storage           = 500
  db_name                         = "acme"
  username                        = "acme_app"
  password                        = random_password.db.result
  multi_az                        = true # synchronous standby: no committed money lost on AZ failure
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.data.arn
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  publicly_accessible             = false
  backup_retention_period         = 14 # point-in-time recovery
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.name}-final"
  auto_minor_version_upgrade      = true
  performance_insights_enabled    = true
  enabled_cloudwatch_logs_exports = ["postgresql"]
}

# Secrets are injected into tasks by ECS at start; they never appear in the task definition or the image.
resource "aws_secretsmanager_secret" "database_url" {
  name       = "${local.name}/database-url"
  kms_key_id = aws_kms_key.data.arn
}
resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  # sslmode=no-verify: encrypted in transit inside the VPC; bundle the RDS CA and use verify-full to harden.
  secret_string = "postgres://acme_app:${random_password.db.result}@${aws_db_instance.main.address}:5432/acme?sslmode=no-verify"
}

resource "aws_secretsmanager_secret" "jwt" {
  name       = "${local.name}/jwt-secret"
  kms_key_id = aws_kms_key.data.arn
}
resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id     = aws_secretsmanager_secret.jwt.id
  secret_string = random_password.jwt.result
}
