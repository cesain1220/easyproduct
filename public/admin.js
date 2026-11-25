let listaProductos = [];
let listaCategorias = [];
let listaPedidos = [];
let imagenSeleccionadaUrl = null;
const tokenAdmin = sessionStorage.getItem('easyproduct_token');
const placeholderImage = 'https://via.placeholder.com/480x360?text=Vista+previa';
const productModal = document.getElementById('productModal');
const categoryModal = document.getElementById('categoryModal');

document.addEventListener('DOMContentLoaded', async () => {
    if (!tokenAdmin) return window.location.replace('login.html');
    try {
        const response = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${tokenAdmin}` } });
        const data = await response.json();
        if (!response.ok || data.usuario.rol !== 'admin') {
            sessionStorage.removeItem('easyproduct_token');
            sessionStorage.removeItem('easyproduct_usuario');
            return window.location.replace(response.ok ? 'index.html' : 'login.html');
        }
        document.getElementById('adminUser').textContent = data.usuario.nombre;
        await cargarDatosAdmin();
    } catch (error) {
        console.error('No se pudo validar la sesión administrativa:', error);
        window.location.replace('login.html');
    }
});

document.getElementById('openProductModal').addEventListener('click', () => abrirModalProducto());
document.getElementById('openCategoryModal').addEventListener('click', () => abrirModalCategoria());
document.getElementById('productsTab').addEventListener('click', () => cambiarPestana('products'));
document.getElementById('ordersTab').addEventListener('click', () => cambiarPestana('orders'));
document.getElementById('productSearch').addEventListener('input', renderTablaProductos);
document.getElementById('categoryFilter').addEventListener('change', renderTablaProductos);
document.getElementById('imagen').addEventListener('change', previsualizarImagen);
document.getElementById('productForm').addEventListener('submit', guardarProducto);
document.getElementById('categoryForm').addEventListener('submit', guardarCategoria);

document.querySelectorAll('[data-close-modal]').forEach(button => {
    button.addEventListener('click', () => button.closest('dialog').close());
});

for (const modal of [productModal, categoryModal]) {
    modal.addEventListener('click', event => {
        if (event.target === modal) modal.close();
    });
}

function cerrarSesionAdmin() {
    sessionStorage.removeItem('easyproduct_token');
    sessionStorage.removeItem('easyproduct_usuario');
    window.location.href = 'index.html';
}

async function adminFetch(url, options = {}) {
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${tokenAdmin}` };
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401 || response.status === 403) {
        sessionStorage.removeItem('easyproduct_token');
        sessionStorage.removeItem('easyproduct_usuario');
        window.location.replace(response.status === 403 ? 'index.html' : 'login.html');
    }
    return response;
}

async function cargarDatosAdmin() {
    const [statsResponse, productsResponse, categoriesResponse, ordersResponse] = await Promise.all([
        adminFetch('/api/admin/stats'),
        fetch('/api/productos'),
        fetch('/api/categorias'),
        adminFetch('/api/pedidos')
    ]);
    const [stats, productos, categorias, pedidos] = await Promise.all([
        leerRespuesta(statsResponse),
        leerRespuesta(productsResponse),
        leerRespuesta(categoriesResponse),
        leerRespuesta(ordersResponse)
    ]);

    listaProductos = productos;
    listaCategorias = categorias;
    listaPedidos = pedidos;
    renderMetricas(stats);
    renderTablaProductos();
    renderTablaPedidos();
    renderCategorias();
}

async function leerRespuesta(response) {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudieron cargar los datos del panel');
    return data;
}

function renderMetricas(stats) {
    document.getElementById('statRevenue').textContent = formatearMoneda(stats.ganancias_totales);
    document.getElementById('statPendingRevenue').textContent = formatearMoneda(stats.ingresos_pendientes);
    document.getElementById('statOrders').textContent = Number(stats.pedidos_totales);
    document.getElementById('statPendingOrders').textContent = `${Number(stats.pedidos_pendientes)} pendientes`;
    document.getElementById('statCompletedOrders').textContent = `${Number(stats.pedidos_completados)} completados`;
    document.getElementById('statProducts').textContent = Number(stats.productos_activos);
    document.getElementById('statCategories').textContent = Number(stats.categorias_totales);
    document.getElementById('productsCount').textContent = listaProductos.length;
    document.getElementById('ordersCount').textContent = listaPedidos.length;
}

function renderCategorias() {
    const options = listaCategorias.map(category =>
        `<option value="${Number(category.id_categoria)}">${escaparHtml(category.nombre)}</option>`
    ).join('');
    document.getElementById('id_categoria').innerHTML = options;
    document.getElementById('categoryFilter').innerHTML =
        '<option value="">Todas las categorías</option>' + options;
    document.getElementById('categoryList').innerHTML = listaCategorias.length
        ? listaCategorias.map(category => `<li>${escaparHtml(category.nombre)}</li>`).join('')
        : '<li class="category-list-empty">Aún no hay categorías.</li>';
}

function renderTablaProductos() {
    const tbody = document.getElementById('adminTableBody');
    const search = document.getElementById('productSearch').value.trim().toLocaleLowerCase();
    const categoryId = document.getElementById('categoryFilter').value;
    const visibles = listaProductos.filter(product => {
        const text = `${product.nombre || ''} ${product.descripcion || ''} ${product.categoria_nombre || ''}`.toLocaleLowerCase();
        return text.includes(search) && (!categoryId || String(product.id_categoria) === categoryId);
    });

    document.getElementById('productResultCount').textContent =
        `${visibles.length} de ${listaProductos.length} productos`;
    if (!visibles.length) {
        tbody.innerHTML = `<tr class="empty-row"><td class="table-empty" colspan="5">${listaProductos.length ? 'No hay productos que coincidan con el filtro.' : 'Todavía no hay productos en el inventario.'}</td></tr>`;
        return;
    }

    tbody.innerHTML = visibles.map(product => `
        <tr>
            <td data-label="Producto">
                <div class="product-cell">
                    <img src="${escaparHtml(product.imagen_url || placeholderImage)}" alt="" class="thumb" onerror="this.src='${placeholderImage}'">
                    <div class="product-cell-copy">
                        <strong>${escaparHtml(product.nombre)}</strong>
                        <small>${escaparHtml(product.descripcion || 'Sin descripción')}</small>
                    </div>
                </div>
            </td>
            <td data-label="Categoría">${escaparHtml(product.categoria_nombre || 'Sin categoría')}</td>
            <td data-label="Precio" class="price-cell">${formatearMoneda(product.precio)}</td>
            <td data-label="Estado"><span class="product-status ${product.disponible ? 'is-active' : 'is-hidden'}">${product.disponible ? 'Activo' : 'Oculto'}</span></td>
            <td data-label="Acciones" class="row-actions">
                <button type="button" class="btn btn-small btn-edit" onclick="editarProducto(${Number(product.id_producto)})">Editar</button>
                <button type="button" class="btn btn-small btn-delete" onclick="eliminarProducto(${Number(product.id_producto)})">Eliminar</button>
            </td>
        </tr>
    `).join('');
}

function renderTablaPedidos() {
    const tbody = document.getElementById('ordersTableBody');
    document.getElementById('ordersCount').textContent = listaPedidos.length;
    if (!listaPedidos.length) {
        tbody.innerHTML = '<tr class="empty-row"><td class="table-empty" colspan="6">Todavía no hay pedidos recibidos.</td></tr>';
        return;
    }

    tbody.innerHTML = listaPedidos.map(order => {
        const date = order.fecha_pedido ? new Date(order.fecha_pedido).toLocaleString('es', {
            dateStyle: 'medium',
            timeStyle: 'short'
        }) : '—';
        const status = ['pendiente', 'confirmado', 'entregado', 'cancelado'].includes(order.estado)
            ? order.estado
            : 'pendiente';
        const details = (order.detalles || []).map(item =>
            `<li><span>${Number(item.cantidad)} × ${escaparHtml(item.nombre_producto)}</span><small>${formatearMoneda(item.subtotal ?? Number(item.precio_unitario) * Number(item.cantidad))}</small></li>`
        ).join('');
        const customer = order.nombre_cliente || order.usuario_nombre || 'Cliente';
        const contact = [
            order.telefono_cliente && `Tel. ${order.telefono_cliente}`,
            order.direccion_entrega && `Dirección: ${order.direccion_entrega}`
        ].filter(Boolean).map(escaparHtml).join('<br>');
        return `
            <tr>
                <td data-label="# Pedido"><span class="order-number">#${Number(order.id_pedido)}</span></td>
                <td data-label="Fecha y hora" class="order-date">${escaparHtml(date)}</td>
                <td data-label="Cliente">
                    <div class="customer-cell"><strong>${escaparHtml(customer)}</strong><small>${contact || 'Sin datos de contacto'}</small></div>
                </td>
                <td data-label="Productos"><ul class="order-items">${details || '<li>Sin detalle disponible</li>'}</ul></td>
                <td data-label="Total" class="price-cell">${formatearMoneda(order.total)}</td>
                <td data-label="Estado">
                    <select class="status-select status-${status}" aria-label="Estado del pedido ${Number(order.id_pedido)}" onchange="actualizarEstadoPedido(${Number(order.id_pedido)}, this.value)">
                        ${['pendiente', 'confirmado', 'entregado', 'cancelado'].map(option =>
                            `<option value="${option}" ${status === option ? 'selected' : ''}>${option[0].toUpperCase()}${option.slice(1)}</option>`
                        ).join('')}
                    </select>
                </td>
            </tr>
        `;
    }).join('');
    actualizarEstiloEstados();
}

function cambiarPestana(tab) {
    const mostrarProductos = tab === 'products';
    document.getElementById('productsTab').classList.toggle('active', mostrarProductos);
    document.getElementById('productsTab').setAttribute('aria-selected', String(mostrarProductos));
    document.getElementById('ordersTab').classList.toggle('active', !mostrarProductos);
    document.getElementById('ordersTab').setAttribute('aria-selected', String(!mostrarProductos));
    document.getElementById('productsPanel').hidden = !mostrarProductos;
    document.getElementById('ordersPanel').hidden = mostrarProductos;
    document.getElementById('productSearch').closest('.admin-toolbar').classList.toggle('is-hidden', !mostrarProductos);
}

function abrirModalProducto(product = null) {
    document.getElementById('productForm').reset();
    document.getElementById('productId').value = product ? product.id_producto : '';
    document.getElementById('formTitle').textContent = product ? 'Editar producto' : 'Nuevo producto';
    document.getElementById('btnSave').textContent = product ? 'Guardar cambios' : 'Guardar producto';
    document.getElementById('nombre').value = product ? product.nombre : '';
    document.getElementById('id_categoria').value = product
        ? product.id_categoria
        : listaCategorias.length ? listaCategorias[0].id_categoria : '';
    document.getElementById('precio').value = product ? product.precio : '';
    document.getElementById('descripcion').value = product ? product.descripcion || '' : '';
    document.getElementById('disponible').value = product && !product.disponible ? 'false' : 'true';
    document.getElementById('imagePreview').src = product && product.imagen_url ? product.imagen_url : placeholderImage;
    productModal.showModal();
}

function editarProducto(id) {
    const product = listaProductos.find(item => Number(item.id_producto) === Number(id));
    if (product) abrirModalProducto(product);
}

function previsualizarImagen(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (imagenSeleccionadaUrl) URL.revokeObjectURL(imagenSeleccionadaUrl);
    imagenSeleccionadaUrl = URL.createObjectURL(file);
    document.getElementById('imagePreview').src = imagenSeleccionadaUrl;
}

async function guardarProducto(event) {
    event.preventDefault();
    const button = document.getElementById('btnSave');
    button.disabled = true;
    button.textContent = 'Guardando...';
    const id = document.getElementById('productId').value;
    const formData = new FormData();
    formData.append('nombre', document.getElementById('nombre').value.trim());
    formData.append('id_categoria', document.getElementById('id_categoria').value);
    formData.append('precio', document.getElementById('precio').value);
    formData.append('descripcion', document.getElementById('descripcion').value.trim());
    formData.append('disponible', document.getElementById('disponible').value);
    const file = document.getElementById('imagen').files[0];
    if (file) formData.append('imagen', file);

    try {
        const response = await adminFetch(id ? `/api/productos/${id}` : '/api/productos', {
            method: id ? 'PUT' : 'POST',
            body: formData
        });
        const data = await leerRespuesta(response);
        productModal.close();
        liberarImagenSeleccionada();
        await cargarDatosAdmin();
    } catch (error) {
        alert(error.message);
    } finally {
        button.disabled = false;
        button.textContent = id ? 'Guardar cambios' : 'Guardar producto';
    }
}

async function eliminarProducto(id) {
    if (!confirm('¿Seguro que deseas eliminar este producto?')) return;
    try {
        const response = await adminFetch(`/api/productos/${id}`, { method: 'DELETE' });
        const data = await leerRespuesta(response);
        await cargarDatosAdmin();
    } catch (error) {
        alert(error.message);
    }
}

function abrirModalCategoria() {
    document.getElementById('categoryForm').reset();
    const message = document.getElementById('categoryMessage');
    message.textContent = '';
    message.className = 'category-message';
    document.getElementById('btnSaveCategory').disabled = false;
    renderCategorias();
    categoryModal.showModal();
}

async function guardarCategoria(event) {
    event.preventDefault();
    const button = document.getElementById('btnSaveCategory');
    const message = document.getElementById('categoryMessage');
    button.disabled = true;
    message.textContent = '';
    message.className = 'category-message';
    try {
        const response = await adminFetch('/api/categorias', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre: document.getElementById('categoryName').value.trim() })
        });
        const data = await leerRespuesta(response);
        await cargarDatosAdmin();
        abrirModalCategoria();
        message.textContent = data.message;
        message.classList.add('success');
    } catch (error) {
        message.textContent = error.message;
        message.classList.add('error');
    } finally {
        button.disabled = false;
    }
}

async function actualizarEstadoPedido(id, estado) {
    const select = document.querySelector(`.status-select[aria-label="Estado del pedido ${Number(id)}"]`);
    if (select) select.disabled = true;
    try {
        const response = await adminFetch(`/api/pedidos/${id}/estado`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ estado })
        });
        await leerRespuesta(response);
        await cargarDatosAdmin();
    } catch (error) {
        alert(error.message);
        await cargarDatosAdmin();
    }
}

function actualizarEstiloEstados() {
    document.querySelectorAll('.status-select').forEach(select => {
        select.className = `status-select status-${select.value}`;
    });
}

function formatearMoneda(value) {
    return new Intl.NumberFormat('es', { style: 'currency', currency: 'USD' }).format(Number(value) || 0);
}

function escaparHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function liberarImagenSeleccionada() {
    if (imagenSeleccionadaUrl) URL.revokeObjectURL(imagenSeleccionadaUrl);
    imagenSeleccionadaUrl = null;
}

productModal.addEventListener('close', liberarImagenSeleccionada);
