require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer en memoria
const upload = multer({ storage: multer.memoryStorage() });

// Pool de conexión a MySQL Local
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});

const jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
if (!process.env.JWT_SECRET) {
    console.warn('JWT_SECRET no está configurado; los tokens dejarán de ser válidos al reiniciar el servidor.');
}

async function authenticate(req, res, next) {
    const authorization = req.headers.authorization || '';
    const [scheme, token] = authorization.split(' ');
    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Autenticación requerida' });
    }

    try {
        const payload = jwt.verify(token, jwtSecret);
        const [users] = await pool.query(
            'SELECT id_usuario, nombre, email, rol FROM usuarios WHERE id_usuario = ? AND activo = TRUE',
            [payload.id_usuario]
        );
        if (users.length === 0) return res.status(401).json({ error: 'Sesión inválida o usuario inactivo' });
        req.user = users[0];
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token inválido o expirado' });
        }
        console.error('Error al validar autenticación:', error);
        res.status(500).json({ error: 'No se pudo validar la sesión' });
    }
}

function requireAdmin(req, res, next) {
    if (req.user.rol !== 'admin') {
        return res.status(403).json({ error: 'Se requieren permisos de administrador' });
    }
    next();
}

// Función auxiliar para subir imagen a Cloudinary
const subirACloudinary = (fileBuffer) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: 'easyproduct' },
            (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }
        );
        stream.end(fileBuffer);
    });
};

// ================= RUTAS API =================

app.post('/api/auth/register', async (req, res) => {
    try {
        const nombre = typeof req.body.nombre === 'string' ? req.body.nombre.trim() : '';
        const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body.password === 'string' ? req.body.password : '';

        if (!nombre || nombre.length > 150 || !email || email.length > 255 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
            return res.status(400).json({ error: 'Ingresa nombre, email válido y contraseña de al menos 8 caracteres' });
        }

        const [existingUsers] = await pool.query('SELECT id_usuario FROM usuarios WHERE email = ?', [email]);
        if (existingUsers.length > 0) return res.status(409).json({ error: 'Ese email ya está registrado' });
        const passwordHash = await bcrypt.hash(password, 12);
        const [result] = await pool.query(
            'INSERT INTO usuarios (nombre, email, password_hash, rol, activo) VALUES (?, ?, ?, ?, TRUE)',
            [nombre, email, passwordHash, 'cliente']
        );
        res.status(201).json({ id_usuario: result.insertId, message: 'Registro creado. Ya puedes iniciar sesión.' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese email ya está registrado' });
        console.error('Error al registrar usuario:', error);
        res.status(500).json({ error: 'No se pudo completar el registro' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body.password === 'string' ? req.body.password : '';
        const [users] = await pool.query(
            'SELECT id_usuario, nombre, email, password_hash, rol FROM usuarios WHERE email = ? AND activo = TRUE',
            [email]
        );
        if (users.length === 0 || !(await bcrypt.compare(password, users[0].password_hash))) {
            return res.status(401).json({ error: 'Email o contraseña incorrectos' });
        }

        const user = users[0];
        if (!['admin', 'cliente'].includes(user.rol)) {
            return res.status(403).json({ error: 'El rol de esta cuenta no está permitido' });
        }
        const usuario = { id_usuario: user.id_usuario, nombre: user.nombre, email: user.email, rol: user.rol };
        const token = jwt.sign({ id_usuario: user.id_usuario }, jwtSecret, { expiresIn: '8h' });
        res.json({ token, usuario });
    } catch (error) {
        console.error('Error al iniciar sesión:', error);
        res.status(500).json({ error: 'No se pudo iniciar sesión' });
    }
});

app.get('/api/auth/me', authenticate, (req, res) => {
    res.json({ usuario: req.user });
});

// Obtener configuración pública (número de WhatsApp)
app.get('/api/config', (req, res) => {
    res.json({ whatsapp: process.env.WHATSAPP_NUMBER || '50370000000' });
});

// Obtener categorías
app.get('/api/categorias', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM categorias WHERE activo = TRUE');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/categorias', authenticate, requireAdmin, async (req, res) => {
    const nombre = typeof req.body.nombre === 'string' ? req.body.nombre.trim() : '';
    if (!nombre) return res.status(400).json({ error: 'El nombre de la categoría es obligatorio' });
    try {
        const [result] = await pool.query('INSERT INTO categorias (nombre, activo) VALUES (?, TRUE)', [nombre]);
        res.status(201).json({ id_categoria: result.insertId, nombre, message: 'Categoría creada' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
        console.error('Error al crear categoría:', error);
        res.status(500).json({ error: 'No se pudo crear la categoría' });
    }
});

// 1. READ: Listar todos los productos con su categoría
app.get('/api/productos', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT p.*, c.nombre AS categoria_nombre 
            FROM productos p
            INNER JOIN categorias c ON p.id_categoria = c.id_categoria
            ORDER BY p.id_producto DESC
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. CREATE: Crear producto + subir imagen a Cloudinary
app.post('/api/productos', authenticate, requireAdmin, upload.single('imagen'), async (req, res) => {
    try {
        const { id_categoria, nombre, descripcion, precio, disponible } = req.body;
        let imagen_url = req.body.imagen_url || 'https://via.placeholder.com/400x300?text=Sin+Imagen';
        let imagen_public_id = null;

        if (req.file && process.env.CLOUDINARY_CLOUD_NAME !== 'tu_cloud_name') {
            const uploadRes = await subirACloudinary(req.file.buffer);
            imagen_url = uploadRes.secure_url;
            imagen_public_id = uploadRes.public_id;
        }

        const [result] = await pool.query(
            `INSERT INTO productos (id_categoria, nombre, descripcion, precio, imagen_url, imagen_public_id, disponible) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id_categoria, nombre, descripcion, precio, imagen_url, imagen_public_id, disponible === 'false' ? 0 : 1]
        );

        res.status(201).json({ id_producto: result.insertId, message: 'Producto creado correctamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al crear producto: ' + error.message });
    }
});

// 3. UPDATE: Actualizar producto
app.put('/api/productos/:id', authenticate, requireAdmin, upload.single('imagen'), async (req, res) => {
    try {
        const { id } = req.params;
        const { id_categoria, nombre, descripcion, precio, disponible } = req.body;

        const [actual] = await pool.query('SELECT * FROM productos WHERE id_producto = ?', [id]);
        if (actual.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });

        let imagen_url = actual[0].imagen_url;
        let imagen_public_id = actual[0].imagen_public_id;

        if (req.file && process.env.CLOUDINARY_CLOUD_NAME !== 'tu_cloud_name') {
            if (imagen_public_id) {
                await cloudinary.uploader.destroy(imagen_public_id).catch(() => {});
            }
            const uploadRes = await subirACloudinary(req.file.buffer);
            imagen_url = uploadRes.secure_url;
            imagen_public_id = uploadRes.public_id;
        }

        await pool.query(
            `UPDATE productos 
             SET id_categoria = ?, nombre = ?, descripcion = ?, precio = ?, imagen_url = ?, imagen_public_id = ?, disponible = ?
             WHERE id_producto = ?`,
            [id_categoria, nombre, descripcion, precio, imagen_url, imagen_public_id, disponible === 'false' ? 0 : 1, id]
        );

        res.json({ message: 'Producto actualizado correctamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar: ' + error.message });
    }
});

app.get('/api/admin/stats', authenticate, requireAdmin, async (req, res) => {
    try {
        const [orderRows, productRows, categoryRows] = await Promise.all([
            pool.query(`
                SELECT
                    COALESCE(SUM(CASE WHEN estado IN ('confirmado', 'entregado') THEN total ELSE 0 END), 0) AS ganancias_totales,
                    COALESCE(SUM(CASE WHEN estado = 'pendiente' THEN total ELSE 0 END), 0) AS ingresos_pendientes,
                    COUNT(*) AS pedidos_totales,
                    COALESCE(SUM(estado = 'pendiente'), 0) AS pedidos_pendientes,
                    COALESCE(SUM(estado = 'entregado'), 0) AS pedidos_completados
                FROM pedidos
            `),
            pool.query('SELECT COUNT(*) AS productos_activos FROM productos WHERE disponible = TRUE'),
            pool.query('SELECT COUNT(*) AS categorias_totales FROM categorias WHERE activo = TRUE')
        ]);
        const orders = orderRows[0][0];
        res.json({
            ganancias_totales: Number(orders.ganancias_totales),
            ingresos_pendientes: Number(orders.ingresos_pendientes),
            pedidos_totales: Number(orders.pedidos_totales),
            pedidos_pendientes: Number(orders.pedidos_pendientes),
            pedidos_completados: Number(orders.pedidos_completados),
            productos_activos: Number(productRows[0][0].productos_activos),
            categorias_totales: Number(categoryRows[0][0].categorias_totales)
        });
    } catch (error) {
        console.error('Error al obtener métricas del administrador:', error);
        res.status(500).json({ error: 'No se pudieron cargar las métricas' });
    }
});

// 4. DELETE: Eliminar producto
app.delete('/api/productos/:id', authenticate, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const [actual] = await pool.query('SELECT imagen_public_id FROM productos WHERE id_producto = ?', [id]);
        
        if (actual.length > 0 && actual[0].imagen_public_id && process.env.CLOUDINARY_CLOUD_NAME !== 'tu_cloud_name') {
            await cloudinary.uploader.destroy(actual[0].imagen_public_id).catch(() => {});
        }

        await pool.query('DELETE FROM productos WHERE id_producto = ?', [id]);
        res.json({ message: 'Producto eliminado' });
    } catch (error) {
        res.status(500).json({ error: 'No se puede eliminar (puede tener pedidos asociados): ' + error.message });
    }
});

// 5. PEDIDOS: Registrar pedido en MySQL antes de abrir WhatsApp
app.post('/api/pedidos', async (req, res) => {
    let conn;
    try {
        const authorization = req.headers.authorization || '';
        let usuario = null;
        if (authorization) {
            const [scheme, token] = authorization.split(' ');
            if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Token inválido' });
            const payload = jwt.verify(token, jwtSecret);
            const [users] = await pool.query(
                'SELECT id_usuario, nombre, rol FROM usuarios WHERE id_usuario = ? AND activo = TRUE',
                [payload.id_usuario]
            );
            if (users.length === 0) return res.status(401).json({ error: 'Sesión inválida o usuario inactivo' });
            usuario = users[0];
            if (usuario.rol !== 'cliente') return res.status(403).json({ error: 'Solo los clientes pueden asociar pedidos a su cuenta' });
        }

        const { nombre_cliente, telefono_cliente, direccion_entrega, notas, items, total } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'El pedido debe incluir al menos un producto' });
        }
        if (!usuario && !nombre_cliente) return res.status(400).json({ error: 'El nombre del cliente es obligatorio' });

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [pedidoRes] = await conn.query(
            `INSERT INTO pedidos (id_usuario, nombre_cliente, telefono_cliente, direccion_entrega, notas, total) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [usuario ? usuario.id_usuario : null, usuario ? usuario.nombre : nombre_cliente, telefono_cliente || null, direccion_entrega || null, notas || null, total]
        );
        const id_pedido = pedidoRes.insertId;

        for (const item of items) {
            await conn.query(
                `INSERT INTO detalle_pedidos (id_pedido, id_producto, nombre_producto, precio_unitario, cantidad) 
                 VALUES (?, ?, ?, ?, ?)`,
                [id_pedido, item.id_producto, item.nombre, item.precio, item.cantidad]
            );
        }

        await conn.commit();
        res.status(201).json({ id_pedido, message: 'Pedido registrado' });
    } catch (error) {
        if (conn) await conn.rollback();
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token inválido o expirado' });
        }
        console.error('Error al registrar pedido:', error);
        res.status(500).json({ error: 'Error al registrar pedido: ' + error.message });
    } finally {
        if (conn) conn.release();
    }
});

app.get('/api/pedidos', authenticate, requireAdmin, async (req, res) => {
    try {
        const [pedidos] = await pool.query(
            `SELECT p.*, u.nombre AS usuario_nombre
             FROM pedidos p LEFT JOIN usuarios u ON p.id_usuario = u.id_usuario
             ORDER BY p.id_pedido DESC`
        );
        const [detalles] = await pool.query(
            'SELECT * FROM detalle_pedidos ORDER BY id_pedido DESC'
        );
        const detallesPorPedido = new Map();
        for (const detalle of detalles) {
            if (!detallesPorPedido.has(detalle.id_pedido)) detallesPorPedido.set(detalle.id_pedido, []);
            detallesPorPedido.get(detalle.id_pedido).push(detalle);
        }
        res.json(pedidos.map(pedido => ({
            ...pedido,
            detalles: detallesPorPedido.get(pedido.id_pedido) || []
        })));
    } catch (error) {
        console.error('Error al obtener pedidos:', error);
        res.status(500).json({ error: 'No se pudieron cargar los pedidos' });
    }
});

app.put('/api/pedidos/:id/estado', authenticate, requireAdmin, async (req, res) => {
    const estados = ['pendiente', 'confirmado', 'entregado', 'cancelado'];
    const { estado } = req.body;
    if (!estados.includes(estado)) return res.status(400).json({ error: 'Estado de pedido inválido' });
    try {
        const [result] = await pool.query('UPDATE pedidos SET estado = ? WHERE id_pedido = ?', [estado, req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Pedido no encontrado' });
        res.json({ message: 'Estado del pedido actualizado' });
    } catch (error) {
        console.error('Error al actualizar pedido:', error);
        res.status(500).json({ error: 'No se pudo actualizar el pedido' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 EASYPRODUCT corriendo en http://localhost:${PORT}`);
});