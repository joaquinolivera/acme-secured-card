output "alb_dns_name" { value = aws_lb.main.dns_name }
output "database_endpoint" { value = aws_db_instance.main.address }
output "migrate_task_definition" { value = aws_ecs_task_definition.migrate.family }
