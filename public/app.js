let productos = [];
let carrito = JSON.parse(localStorage.getItem('easyproduct_cart')) || [];
let whatsappNumber = '50370000000';

document.addEventListener('DOMContentLoaded', async () => {
    actualizarNavegacion();
    autocompletarCliente();
    await cargarConfig();
    await cargarCategorias();
    await cargarProductos();
    renderCarrito();
});

function obtenerSesion() {
    try {
        return JSON.parse(sessionStorage.getItem('easyproduct_usuario') || 'null');
    } catch (error) {
        sessionStorage.removeItem('easyproduct_usuario');
        return null;
    }
}

function actualizarNavegacion() {
    const nav = document.getElementById('authNav');
    const usuario = obtenerSesion();
    if (!usuario) {
        nav.innerHTML = '<a class="btn btn-primary" href="login.html">Iniciar Sesión</a>';
        return;
    }
    const nombre = document.createElement('span');
    nombre.className = 'nav-user';
    nombre.textContent = usuario.nombre;
    nav.replaceChildren(nombre);
    if (usuario.rol === 'admin') {
        const admin = document.createElement('a');
        admin.className = 'btn btn-primary';
        admin.href = 'admin.html';
        admin.textContent = '⚙️ Panel Admin';
        nav.appendChild(admin);
    }
    const logout = document.createElement('button');
    logout.className = 'btn btn-outline';
    logout.textContent = 'Cerrar Sesión';
    logout.addEventListener('click', cerrarSesion);
    nav.appendChild(logout);
}

function autocompletarCliente() {
    const usuario = obtenerSesion();
    const campoNombre = document.getElementById('clienteNombre');
    if (usuario && usuario.rol === 'cliente') {
        campoNombre.value = usuario.nombre;
        campoNombre.readOnly = true;
    }
}

function cerrarSesion() {
    sessionStorage.removeItem('easyproduct_token');
    sessionStorage.removeItem('easyproduct_usuario');
    window.location.reload();
}

async function cargarConfig() {
    const res = await fetch('/api/config');
    const data = await res.json();
    whatsappNumber = data.whatsapp;
}

async function cargarCategorias() {
    const res = await fetch('/api/categorias');
    const categorias = await res.json();
    const select = document.getElementById('categoryFilter');
    categorias.forEach(c => {
        select.innerHTML += `<option value="${c.id_categoria}">${c.nombre}</option>`;
    });
}

async function cargarProductos() {
    const res = await fetch('/api/productos');
    productos = await res.json();
    // Mostrar solo disponibles al público
    renderProductos(productos.filter(p => p.disponible));
}

function renderProductos(lista) {
    const grid = document.getElementById('productGrid');
    if (lista.length === 0) {
        grid.innerHTML = '<p style="color:var(--muted)">No se encontraron productos.</p>';
        return;
    }
    grid.innerHTML = lista.map(p => `
        <article class="card">
            <img src="${p.imagen_url}" alt="${p.nombre}" onerror="this.src='https://via.placeholder.com/400x300?text=Producto'">
            <div class="card-body">
                <span class="card-cat">${p.categoria_nombre}</span>
                <h3 class="card-title">${p.nombre}</h3>
                <p class="card-desc">${p.descripcion || ''}</p>
                <div class="card-footer">
                    <span class="price">$${parseFloat(p.precio).toFixed(2)}</span>
                    <button class="btn btn-primary" onclick="agregarAlCarrito(${p.id_producto})">+ Agregar</button>
                </div>
            </div>
        </article>
    `).join('');
}

function filtrarProductos() {
    const texto = document.getElementById('searchInput').value.toLowerCase();
    const cat = document.getElementById('categoryFilter').value;
    const filtrados = productos.filter(p => {
        const coincideTexto = p.nombre.toLowerCase().includes(texto) || (p.descripcion && p.descripcion.toLowerCase().includes(texto));
        const coincideCat = cat === '' || p.id_categoria == cat;
        return p.disponible && coincideTexto && coincideCat;
    });
    renderProductos(filtrados);
}

// --- Lógica del Carrito ---
function toggleCart() {
    document.getElementById('cartDrawer').classList.toggle('open');
    document.getElementById('overlay').classList.toggle('open');
}

function agregarAlCarrito(id) {
    const prod = productos.find(p => p.id_producto === id);
    const existe = carrito.find(item => item.id_producto === id);
    if (existe) {
        existe.cantidad++;
    } else {
        carrito.push({ id_producto: prod.id_producto, nombre: prod.nombre, precio: parseFloat(prod.precio), cantidad: 1 });
    }
    guardarYRenderizar();
}

function cambiarCantidad(id, delta) {
    const item = carrito.find(i => i.id_producto === id);
    if (!item) return;
    item.cantidad += delta;
    if (item.cantidad <= 0) {
        carrito = carrito.filter(i => i.id_producto !== id);
    }
    guardarYRenderizar();
}

function guardarYRenderizar() {
    localStorage.setItem('easyproduct_cart', JSON.stringify(carrito));
    renderCarrito();
}

function renderCarrito() {
    const container = document.getElementById('cartItems');
    const countBadge = document.getElementById('cart-count');
    const totalEl = document.getElementById('cartTotal');

    const totalItems = carrito.reduce((acc, i) => acc + i.cantidad, 0);
    const totalPrecio = carrito.reduce((acc, i) => acc + (i.precio * i.cantidad), 0);

    countBadge.textContent = totalItems;
    totalEl.textContent = `$${totalPrecio.toFixed(2)}`;

    if (carrito.length === 0) {
        container.innerHTML = '<p style="color:var(--muted); text-align:center; margin-top:2rem;">Tu carrito está vacío</p>';
        return;
    }

    container.innerHTML = carrito.map(item => `
        <div class="cart-item">
            <div>
                <strong>${item.nombre}</strong>
                <div style="font-size:0.85rem; color:var(--muted)">$${item.precio.toFixed(2)} c/u</div>
            </div>
            <div class="qty-controls">
                <button class="qty-btn" onclick="cambiarCantidad(${item.id_producto}, -1)">-</button>
                <span>${item.cantidad}</span>
                <button class="qty-btn" onclick="cambiarCantidad(${item.id_producto}, 1)">+</button>
            </div>
        </div>
    `).join('');
}

async function enviarPedidoWhatsApp() {
    if (carrito.length === 0) return alert('Agrega al menos un producto al carrito.');
    const nombre = document.getElementById('clienteNombre').value.trim();
    if (!nombre) return alert('Por favor ingresa tu nombre para el pedido.');

    const telefono = document.getElementById('clienteTelefono').value.trim();
    const direccion = document.getElementById('clienteDireccion').value.trim();
    const total = carrito.reduce((acc, i) => acc + (i.precio * i.cantidad), 0);

    // 1. Guardar el pedido en MySQL local
    let idPedido = '';
    try {
        const token = sessionStorage.getItem('easyproduct_token');
        const res = await fetch('/api/pedidos', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ nombre_cliente: nombre, telefono_cliente: telefono, direccion_entrega: direccion, items: carrito, total })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo registrar el pedido');
        if (data.id_pedido) idPedido = ` #${data.id_pedido}`;
    } catch (e) {
        console.error('No se pudo guardar el pedido en la base de datos', e);
        return alert(e.message || 'No se pudo guardar el pedido. Inténtalo nuevamente.');
    }

    // 2. Construir mensaje de WhatsApp
    let mensaje = `Hola *EASYPRODUCT*, quiero realizar el siguiente pedido${idPedido}:\n\n`;
    mensaje += `*Cliente:* ${nombre}\n`;
    if (direccion) mensaje += `*Dirección:* ${direccion}\n`;
    mensaje += `\n*Detalle del pedido:*\n`;
    carrito.forEach(i => {
        mensaje += `• ${i.cantidad}x ${i.nombre} - $${(i.precio * i.cantidad).toFixed(2)}\n`;
    });
    mensaje += `\n*TOTAL A PAGAR: $${total.toFixed(2)}*`;

    const url = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(mensaje)}`;
    
    // Limpiar carrito y abrir WhatsApp
    carrito = [];
    guardarYRenderizar();
    window.open(url, '_blank');
}