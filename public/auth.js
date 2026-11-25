const authForm = document.getElementById('authForm');
const nameGroup = document.getElementById('nameGroup');
const nameInput = document.getElementById('authName');
const passwordInput = document.getElementById('authPassword');
const message = document.getElementById('authMessage');
let modoRegistro = false;

document.getElementById('loginTab').addEventListener('click', () => cambiarModo(false));
document.getElementById('registerTab').addEventListener('click', () => cambiarModo(true));

function cambiarModo(registro) {
    modoRegistro = registro;
    document.getElementById('loginTab').classList.toggle('active', !registro);
    document.getElementById('registerTab').classList.toggle('active', registro);
    nameGroup.hidden = !registro;
    nameInput.required = registro;
    passwordInput.autocomplete = registro ? 'new-password' : 'current-password';
    document.getElementById('passwordHint').hidden = !registro;
    document.getElementById('authTitle').textContent = registro ? 'Crea tu cuenta' : 'Bienvenido de nuevo';
    document.getElementById('authSubtitle').textContent = registro
        ? 'Regístrate para realizar tus pedidos'
        : 'Inicia sesión para continuar';
    document.getElementById('submitButton').textContent = registro ? 'Crear Cuenta' : 'Iniciar Sesión';
    message.textContent = '';
    message.className = 'auth-message';
}

authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('submitButton');
    button.disabled = true;
    message.textContent = '';
    message.className = 'auth-message';

    const body = {
        email: document.getElementById('authEmail').value.trim(),
        password: passwordInput.value
    };
    if (modoRegistro) body.nombre = nameInput.value.trim();

    try {
        const response = await fetch(`/api/auth/${modoRegistro ? 'register' : 'login'}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud');
        if (modoRegistro) {
            cambiarModo(false);
            document.getElementById('authEmail').value = body.email;
            message.textContent = data.message;
            message.classList.add('success');
        } else {
            sessionStorage.setItem('easyproduct_token', data.token);
            sessionStorage.setItem('easyproduct_usuario', JSON.stringify(data.usuario));
            window.location.href = data.usuario.rol === 'admin' ? 'admin.html' : 'index.html';
        }
    } catch (error) {
        message.textContent = error.message;
        message.classList.add('error');
    } finally {
        button.disabled = false;
    }
});
