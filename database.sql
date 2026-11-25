-- Authentication support for the existing EASYPRODUCT database.
-- Run against easyproduct_db after the existing catalog/order tables are created.

CREATE TABLE IF NOT EXISTS usuarios (
    id_usuario INT NOT NULL AUTO_INCREMENT,
    nombre VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    rol ENUM('admin', 'cliente') NOT NULL DEFAULT 'cliente',
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id_usuario),
    UNIQUE KEY uq_usuarios_email (email)
);

-- Add the user relationship only when the column is not already present.
SET @easyproduct_id_usuario_exists = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'pedidos'
      AND COLUMN_NAME = 'id_usuario'
);
SET @easyproduct_migration = IF(
    @easyproduct_id_usuario_exists = 0,
    'ALTER TABLE pedidos ADD COLUMN id_usuario INT NULL',
    'SELECT 1'
);
PREPARE easyproduct_statement FROM @easyproduct_migration;
EXECUTE easyproduct_statement;
DEALLOCATE PREPARE easyproduct_statement;

-- Guarantee email uniqueness even when usuarios already existed.
SET @easyproduct_email_unique_exists = (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'usuarios'
      AND COLUMN_NAME = 'email'
      AND NON_UNIQUE = 0
);
SET @easyproduct_email_migration = IF(
    @easyproduct_email_unique_exists = 0,
    'ALTER TABLE usuarios ADD UNIQUE KEY uq_usuarios_email (email)',
    'SELECT 1'
);
PREPARE easyproduct_email_statement FROM @easyproduct_email_migration;
EXECUTE easyproduct_email_statement;
DEALLOCATE PREPARE easyproduct_email_statement;

-- Test account: admin@easyproduct.com / admin123
-- The password is stored as a bcrypt hash (cost 12).
INSERT INTO usuarios (nombre, email, password_hash, rol, activo)
SELECT 'Administrador', 'admin@easyproduct.com',
       '$2b$12$4K8Gk5Zb/6E.rVw8znrtPeepbGVQk5OloiqTN9LecyWZYglE792Sa',
       'admin', TRUE
WHERE NOT EXISTS (SELECT 1 FROM usuarios WHERE rol = 'admin')
ON DUPLICATE KEY UPDATE email = VALUES(email);