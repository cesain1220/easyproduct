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

// ===== Cloudinary =====
if (!process.env.CLOUDINARY_URL) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
}

const cloudinaryListo = Boolean(
    process.env.CLOUDINARY_URL ||
    (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
);

if (!cloudinaryListo) {
    console.warn('Cloudinary no está configurado: no se podrán subir imágenes de productos.');
}

const IMAGEN_POR_DEFECTO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300' viewBox='0 0 400 300'%3E%3Crect width='400' height='300' fill='%23e2e8f0'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='18' fill='%2364748b'%3ESin imagen%3C/text%3E%3C/svg%3E";
const TIPOS_IMAGEN = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGEN = 5 * 1024 * 1024;

// ===== Multer: en memoria, 1 imagen, máx. 5 MB, solo JPG/PNG/WEBP =====
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGEN, files: 1 },
    fileFilter: (req, file, cb) =>
        TIPOS_IMAGEN.includes(file.mimetype)
            ? cb(null, true)
            : cb(new Error('Solo se permiten imágenes JPG, PNG o WEBP'))
});

const recibirImagen = (req, res, next) => {
    upload.single('imagen')(req, res, (err) => {
        if (!err) return next();
        const mensaje = err.code === 'LIMIT_FILE_SIZE'
            ? 'La imagen no puede pasar de 5 MB'
            : err.message;
        res.status(400).json({ error: mensaje });
    });
};

const subirACloudinary = (fileBuffer) => new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
        {
            folder: 'easyproduct',
            resource_type: 'image',
            transformation: [
                { width: 1200, height: 1200, crop: 'limit' },
                { quality: 'auto', fetch_format: 'auto' }
            ]
        },
        (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(fileBuffer);
});

const borrarImagen = async (publicId) => {
    if (!publicId || !cloudinaryListo) return;
    try {
        await cloudinary.uploader.destroy(publicId);
    } catch (e) {
        console.warn('No se pudo borrar la imagen de Cloudinary:', publicId, e.message);
    }
};

function leerProducto(body) {
    const nombre = String(body.nombre || '').trim();
    const descripcion = String(body.descripcion || '').trim().slice(0, 1000);
    const precio = Number(body.precio);
    const id_categoria = Number(body.id_categoria);

    if (!nombre || nombre.length > 180) return { error: 'El nombre es obligatorio (máx. 180 caracteres)' };
    if (!Number.isFinite(precio) || precio < 0 || precio > 1000000) return { error: 'El precio no es válido' };
    if (!Number.isInteger(id_categoria) || id_categoria <= 0) return { error: 'Elige una categoría' };

    return {
        nombre,
        descripcion,
        precio,
        id_categoria,
        disponible: body.disponible === 'false' ? 0 : 1
    };
}

// ===== Pool de conexión a MySQL en la nube (Aiven) =====
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 12425,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'defaultdb',
    ssl: {
        rejectUnauthorized: false
    },
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

app.get('/api/config', (req, res) => {
    res.json({ whatsapp: process.env.WHATSAPP_NUMBER || '50370000000' });
});

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

// 1. READ: Público (solo disponibles) y Admin (todos)
app.get('/api/productos', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT p.*, c.nombre AS categoria_nombre 
            FROM productos p
            INNER JOIN categorias c ON p.id_categoria = c.id_categoria
            WHERE p.disponible = TRUE
            ORDER BY p.id_producto DESC
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/productos', authenticate, requireAdmin, async (req, res) => {
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
app.post('/api/productos', authenticate, requireAdmin, recibirImagen, async (req, res) => {
    let subida = null;
    try {
        const p = leerProducto(req.body);
        if (p.error) return res.status(400).json({ error: p.error });

        let imagen_url = IMAGEN_POR_DEFECTO;
        let imagen_public_id = null;

        if (req.file) {
            if (!cloudinaryListo) {
                return res.status(503).json({ error: 'El almacenamiento de imágenes no está configurado en el servidor' });
            }
            subida = await subirACloudinary(req.file.buffer);
            imagen_url = subida.secure_url;
            imagen_public_id = subida.public_id;
        }

        const [result] = await pool.query(
            `INSERT INTO productos (id_categoria, nombre, descripcion, precio, imagen_url, imagen_public_id, disponible) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [p.id_categoria, p.nombre, p.descripcion, p.precio, imagen_url, imagen_public_id, p.disponible]
        );

        res.status(201).json({ id_producto: result.insertId, message: 'Producto creado correctamente' });
    } catch (error) {
        if (subida) await borrarImagen(subida.public_id);
        if (error.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'La categoría no existe' });
        console.error('Error al crear producto:', error);
        res.status(500).json({ error: 'No se pudo crear el producto' });
    }
});

// 3. UPDATE: Actualizar producto
app.put('/api/productos/:id', authenticate, requireAdmin, recibirImagen, async (req, res) => {
    let subida = null;
    try {
        const p = leerProducto(req.body);
        if (p.error) return res.status(400).json({ error: p.error });

        const [actual] = await pool.query('SELECT imagen_url, imagen_public_id FROM productos WHERE id_producto = ?', [req.params.id]);
        if (actual.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });

        let imagen_url = actual[0].imagen_url;
        let imagen_public_id = actual[0].imagen_public_id;
        const anterior = actual[0].imagen_public_id;

        if (req.file) {
            if (!cloudinaryListo) {
                return res.status(503).json({ error: 'El almacenamiento de imágenes no está configurado en el servidor' });
            }
            subida = await subirACloudinary(req.file.buffer);
            imagen_url = subida.secure_url;
            imagen_public_id = subida.public_id;
        }

        await pool.query(
            `UPDATE productos 
             SET id_categoria = ?, nombre = ?, descripcion = ?, precio = ?, imagen_url = ?, imagen_public_id = ?, disponible = ?
             WHERE id_producto = ?`,
            [p.id_categoria, p.nombre, p.descripcion, p.precio, imagen_url, imagen_public_id, p.disponible, req.params.id]
        );

        if (subida) await borrarImagen(anterior);
        res.json({ message: 'Producto actualizado correctamente' });
    } catch (error) {
        if (subida) await borrarImagen(subida.public_id);
        if (error.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'La categoría no existe' });
        console.error('Error al actualizar producto:', error);
        res.status(500).json({ error: 'No se pudo actualizar el producto' });
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
        const [actual] = await pool.query('SELECT imagen_public_id FROM productos WHERE id_producto = ?', [req.params.id]);
        if (actual.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });

        await pool.query('DELETE FROM productos WHERE id_producto = ?', [req.params.id]);
        await borrarImagen(actual[0].imagen_public_id);
        res.json({ message: 'Producto eliminado' });
    } catch (error) {
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(409).json({ error: 'No se puede eliminar: el producto tiene pedidos asociados. Mejor márcalo como «Oculto».' });
        }
        console.error('Error al eliminar producto:', error);
        res.status(500).json({ error: 'No se pudo eliminar el producto' });
    }
});

// 5. PEDIDOS: Recalcula precios reales desde la BD en el servidor
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

        const { nombre_cliente, telefono_cliente, direccion_entrega, notas, items } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'El pedido debe incluir al menos un producto' });
        }
        if (!usuario && !nombre_cliente) return res.status(400).json({ error: 'El nombre del cliente es obligatorio' });

        conn = await pool.getConnection();
        await conn.beginTransaction();

        const ids = [...new Set(items.map(i => Number(i.id_producto)))].filter(id => Number.isInteger(id) && id > 0);
        if (ids.length === 0) {
            await conn.rollback();
            return res.status(400).json({ error: 'Productos inválidos en el pedido' });
        }

        const [productosDb] = await conn.query(
            'SELECT id_producto, nombre, precio, disponible FROM productos WHERE id_producto IN (?)',
            [ids]
        );
        const mapaProductos = new Map(productosDb.map(p => [p.id_producto, p]));

        let totalCalculado = 0;
        const itemsValidados = [];

        for (const item of items) {
            const prodDb = mapaProductos.get(Number(item.id_producto));
            const cantidad = Number(item.cantidad);
            if (!prodDb || !prodDb.disponible) {
                await conn.rollback();
                return res.status(400).json({ error: `El producto "${item.nombre || item.id_producto}" no está disponible` });
            }
            if (!Number.isInteger(cantidad) || cantidad <= 0 || cantidad > 100) {
                await conn.rollback();
                return res.status(400).json({ error: 'Cantidad inválida en el carrito' });
            }
            const precioReal = Number(prodDb.precio);
            totalCalculado += precioReal * cantidad;
            itemsValidados.push({
                id_producto: prodDb.id_producto,
                nombre: prodDb.nombre,
                precio: precioReal,
                cantidad
            });
        }

        const [pedidoRes] = await conn.query(
            `INSERT INTO pedidos (id_usuario, nombre_cliente, telefono_cliente, direccion_entrega, notas, total) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                usuario ? usuario.id_usuario : null,
                usuario ? usuario.nombre : String(nombre_cliente).trim(),
                telefono_cliente ? String(telefono_cliente).trim() : null,
                direccion_entrega ? String(direccion_entrega).trim() : null,
                notas ? String(notas).trim() : null,
                totalCalculado
            ]
        );
        const id_pedido = pedidoRes.insertId;

        for (const item of itemsValidados) {
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
        res.status(500).json({ error: 'Error al registrar pedido' });
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