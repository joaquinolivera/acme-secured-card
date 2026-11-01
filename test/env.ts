process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres@localhost:5432/acme_test';
process.env['JWT_SECRET'] = 'test-secret-test-secret-test-secret-123';
process.env['ALLOW_SIMULATED_TIME'] = 'true';
process.env['LOG_LEVEL'] ??= 'silent';
