let socket;
let currentUser = null;
let token = localStorage.getItem('chat_token');
let username = localStorage.getItem('chat_username');
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let currentView = 'chat';
let boardItems = [];
let editingItemId = null;
let allUsers = [];
let latency = 0;

// Initialisation
window.onload = () => {
    // Si on a déjà un token, essayer de se connecter directement
    if (token && username) {
        connectToChat();
    }

    // Event listeners
    document.getElementById('message-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendMessage();
        }
    });

    document.getElementById('login-username').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') login();
    });

    document.getElementById('login-password').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') login();
    });

    document.getElementById('register-username').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') register();
    });

    document.getElementById('register-password').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') register();
    });
};

// Afficher le formulaire de connexion
function showLogin() {
    document.getElementById('login-form').classList.remove('hidden');
    document.getElementById('register-form').classList.add('hidden');
}

// Afficher le formulaire d'inscription
function showRegister() {
    document.getElementById('login-form').classList.add('hidden');
    document.getElementById('register-form').classList.remove('hidden');
}

// Inscription
async function register() {
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;
    const messageEl = document.getElementById('register-message');

    if (!username || !password) {
        messageEl.innerHTML = '<div class="error">Veuillez remplir tous les champs</div>';
        return;
    }

    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (data.success) {
            messageEl.innerHTML = '<div class="success">Compte créé ! Connexion...</div>';
            token = data.token;
            localStorage.setItem('chat_token', token);
            localStorage.setItem('chat_username', username);
            
            setTimeout(() => {
                connectToChat();
            }, 500);
        } else {
            messageEl.innerHTML = `<div class="error">${data.error}</div>`;
        }
    } catch (error) {
        messageEl.innerHTML = '<div class="error">Erreur de connexion au serveur</div>';
    }
}

// Connexion
async function login() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const messageEl = document.getElementById('login-message');

    if (!username || !password) {
        messageEl.innerHTML = '<div class="error">Veuillez remplir tous les champs</div>';
        return;
    }

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (data.success) {
            messageEl.innerHTML = '<div class="success">Connexion réussie !</div>';
            token = data.token;
            localStorage.setItem('chat_token', token);
            localStorage.setItem('chat_username', data.username);
            
            setTimeout(() => {
                connectToChat();
            }, 500);
        } else {
            messageEl.innerHTML = `<div class="error">${data.error}</div>`;
        }
    } catch (error) {
        messageEl.innerHTML = '<div class="error">Erreur de connexion au serveur</div>';
    }
}

// Connexion au chat via Socket.IO
function connectToChat() {
    // Initialiser Socket.IO avec reconnexion automatique
    socket = io({
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: MAX_RECONNECT_ATTEMPTS
    });

    // Événement de connexion
    socket.on('connect', () => {
        console.log('Connecté au serveur WebSocket');
        updateConnectionStatus(true);
        reconnectAttempts = 0;

        // Authentification avec le token
        socket.emit('authenticate', { token });
    });

    // Authentification réussie
    socket.on('authenticated', (data) => {
        if (data.success) {
            currentUser = data.username;
            document.getElementById('current-username').textContent = currentUser;
            
            // Afficher l'écran de chat
            document.getElementById('auth-screen').style.display = 'none';
            document.getElementById('chat-screen').style.display = 'flex';

            console.log(`Authentifié en tant que ${currentUser}`);
            
            // Démarrer le monitoring
            startMonitoring();
        } else {
            // Token invalide, retour à l'authentification
            localStorage.removeItem('chat_token');
            localStorage.removeItem('chat_username');
            token = null;
            showLogin();
        }
    });

    // Historique des messages
    socket.on('message_history', (messages) => {
        const messagesContainer = document.getElementById('messages');
        messagesContainer.innerHTML = '';
        messages.forEach(msg => {
            addMessageToUI(msg.username, msg.content, msg.timestamp);
        });
        scrollToBottom();
    });

    // Nouveau message
    socket.on('new_message', (data) => {
        addMessageToUI(data.username, data.content, data.timestamp);
        scrollToBottom();
    });

    // Liste des utilisateurs
    socket.on('user_list', (data) => {
        updateUserList(data.users);
    });

    // Utilisateur rejoint
    socket.on('user_joined', (data) => {
        addNotification(`${data.username} a rejoint le chat`);
    });

    // Utilisateur parti
    socket.on('user_left', (data) => {
        addNotification(`${data.username} a quitté le chat`);
    });

    // Données de monitoring
    socket.on('monitoring_data', (data) => {
        document.getElementById('active-connections').textContent = data.activeConnections;
        document.getElementById('total-connections').textContent = data.totalConnections;
        document.getElementById('messages-count').textContent = data.messagesCount;
    });

    // Pong pour calculer la latence
    socket.on('pong_latency', (timestamp) => {
        latency = Date.now() - timestamp;
        document.getElementById('latency').textContent = latency;
    });

    // Erreurs
    socket.on('error', (data) => {
        console.error('Erreur:', data.message);
        addNotification(`Erreur: ${data.message}`);
    });

    // Déconnexion
    socket.on('disconnect', (reason) => {
        console.log('Déconnecté:', reason);
        updateConnectionStatus(false);
        
        if (reason === 'io server disconnect') {
            // Le serveur a forcé la déconnexion, réauthentification nécessaire
            socket.connect();
        }
    });

    // Tentative de reconnexion
    socket.on('reconnect_attempt', (attemptNumber) => {
        reconnectAttempts = attemptNumber;
        console.log(`Tentative de reconnexion ${attemptNumber}/${MAX_RECONNECT_ATTEMPTS}`);
        addNotification(`Reconnexion en cours... (${attemptNumber}/${MAX_RECONNECT_ATTEMPTS})`);
    });

    // Reconnexion réussie
    socket.on('reconnect', (attemptNumber) => {
        console.log(`Reconnecté après ${attemptNumber} tentative(s)`);
        addNotification('Reconnecté avec succès !');
    });

    // Échec de reconnexion
    socket.on('reconnect_failed', () => {
        console.error('Échec de reconnexion après plusieurs tentatives');
        addNotification('Impossible de se reconnecter. Rechargez la page.');
    });

    // ========== BOARD EVENTS ==========

    // Réception des utilisateurs connectés
    socket.on('connected_users', (users) => {
        allUsers = users;
        updateUserSelect();
    });

    // Réception de tous les items du board
    socket.on('board_items', (items) => {
        boardItems = items;
        renderBoard();
    });

    // Nouvel item créé
    socket.on('board_item_created', (item) => {
        boardItems.push(item);
        renderBoard();
    });

    // Item mis à jour
    socket.on('board_item_updated', (data) => {
        const item = boardItems.find(i => i.id === data.id);
        if (item) {
            if (data.title !== undefined) item.title = data.title;
            if (data.content !== undefined) item.content = data.content;
            if (data.column_name !== undefined) item.column_name = data.column_name;
            if (data.assigned_to !== undefined) item.assigned_to = data.assigned_to;
            item.updated_at = data.updated_at;
            renderBoard();
        }
    });

    // Item supprimé
    socket.on('board_item_deleted', (data) => {
        boardItems = boardItems.filter(i => i.id !== data.id);
        renderBoard();
    });
}

// Envoyer un message
function sendMessage() {
    const input = document.getElementById('message-input');
    const content = input.value.trim();

    if (!content) return;

    if (!socket || !socket.connected) {
        addNotification('Non connecté au serveur');
        return;
    }

    socket.emit('send_message', { content });
    input.value = '';
}

// Ajouter un message à l'interface
function addMessageToUI(username, content, timestamp) {
    const messagesContainer = document.getElementById('messages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${username === currentUser ? 'own' : ''}`;

    const time = new Date(timestamp).toLocaleTimeString('fr-FR', { 
        hour: '2-digit', 
        minute: '2-digit' 
    });

    messageDiv.innerHTML = `
        <div class="message-header">
            <span class="message-username">${escapeHtml(username)}</span>
            <span class="message-time">${time}</span>
        </div>
        <div class="message-content">${escapeHtml(content)}</div>
    `;

    messagesContainer.appendChild(messageDiv);
}

// Ajouter une notification
function addNotification(text) {
    const messagesContainer = document.getElementById('messages');
    const notificationDiv = document.createElement('div');
    notificationDiv.className = 'notification';
    notificationDiv.textContent = text;
    messagesContainer.appendChild(notificationDiv);
    scrollToBottom();
}

// Mettre à jour la liste des utilisateurs
function updateUserList(users) {
    const userList = document.getElementById('user-list');
    userList.innerHTML = '';
    
    users.forEach(user => {
        const li = document.createElement('li');
        li.textContent = user;
        if (user === currentUser) {
            li.style.fontWeight = 'bold';
            li.style.color = '#00ff00';
            li.style.textShadow = '0 0 5px #00ff00';
        }
        userList.appendChild(li);
    });
}

// Mettre à jour le statut de connexion
function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('connection-status');
    if (connected) {
        statusEl.classList.remove('disconnected');
    } else {
        statusEl.classList.add('disconnected');
    }
}

// Démarrer le monitoring
function startMonitoring() {
    setInterval(() => {
        if (socket && socket.connected) {
            socket.emit('get_monitoring');
            socket.emit('ping_latency', Date.now());
        }
    }, 2000);
}

// Faire défiler vers le bas
function scrollToBottom() {
    const messagesContainer = document.getElementById('messages');
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Échapper le HTML pour éviter XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========== BOARD FUNCTIONS ==========

// Basculer entre les vues
function switchTab(tab) {
    currentView = tab;
    
    // Mettre à jour les onglets
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(t => t.classList.remove('active'));
    
    // Trouver l'onglet cliqué
    const clickedTab = Array.from(tabs).find(t => {
        if (tab === 'chat') return t.textContent.includes('Chat');
        if (tab === 'board') return t.textContent.includes('Board');
        return false;
    });
    if (clickedTab) clickedTab.classList.add('active');
    
    // Basculer les vues
    const chatView = document.getElementById('chat-view');
    const boardView = document.getElementById('board-view');
    
    if (tab === 'chat') {
        chatView.classList.add('active');
        boardView.classList.remove('active');
    } else if (tab === 'board') {
        chatView.classList.remove('active');
        boardView.classList.add('active');
        
        // Charger les items du board et les utilisateurs connectés
        if (socket && socket.connected) {
            socket.emit('get_board_items');
            socket.emit('get_connected_users');
        }
    }
}

// Mettre à jour le select des utilisateurs
function updateUserSelect() {
    const select = document.getElementById('item-assigned');
    select.innerHTML = '<option value="">Personne</option>';
    allUsers.forEach(user => {
        const option = document.createElement('option');
        option.value = user;
        option.textContent = user;
        select.appendChild(option);
    });
}

// Rendre le board
function renderBoard() {
    const columns = ['todo', 'inprogress', 'done'];
    
    columns.forEach(column => {
        const columnEl = document.getElementById(`column-${column}`);
        const countEl = document.getElementById(`count-${column}`);
        const items = boardItems.filter(item => item.column_name === column);
        
        countEl.textContent = items.length;
        columnEl.innerHTML = '';
        
        items.forEach(item => {
            const itemEl = document.createElement('div');
            itemEl.className = 'board-item';
            itemEl.dataset.id = item.id;
            
            const time = new Date(item.created_at).toLocaleDateString('fr-FR', {
                day: '2-digit',
                month: '2-digit'
            });
            
            itemEl.innerHTML = `
                <div class="board-item-header">
                    <div class="board-item-title">${escapeHtml(item.title)}</div>
                    <div class="board-item-actions">
                        ${column !== 'todo' ? `<button onclick="moveItem(${item.id}, 'left')" title="Déplacer à gauche">←</button>` : ''}
                        ${column !== 'done' ? `<button onclick="moveItem(${item.id}, 'right')" title="Déplacer à droite">→</button>` : ''}
                        <button onclick="editItem(${item.id})" title="Éditer">✎</button>
                        <button onclick="deleteItem(${item.id})" title="Supprimer">×</button>
                    </div>
                </div>
                ${item.content ? `<div class="board-item-content">${escapeHtml(item.content)}</div>` : ''}
                ${item.assigned_to ? `<div class="board-item-content"><strong>Assigné à:</strong> ${escapeHtml(item.assigned_to)}</div>` : ''}
                <div class="board-item-meta">
                    <span class="board-item-author">${escapeHtml(item.username)}</span>
                    <span>${time}</span>
                </div>
            `;
            
            columnEl.appendChild(itemEl);
        });
    });
}

// Ouvrir le modal de création
function openCreateItemModal() {
    editingItemId = null;
    document.getElementById('modal-title').textContent = 'Nouvel item';
    document.getElementById('item-title').value = '';
    document.getElementById('item-content').value = '';
    document.getElementById('item-assigned').value = '';
    document.getElementById('item-column').value = 'todo';
    document.getElementById('item-modal').classList.add('active');
}

// Fermer le modal
function closeItemModal() {
    document.getElementById('item-modal').classList.remove('active');
    editingItemId = null;
}

// Sauvegarder un item (création ou édition)
function saveItem() {
    const title = document.getElementById('item-title').value.trim();
    const content = document.getElementById('item-content').value.trim();
    const assignedTo = document.getElementById('item-assigned').value;
    const column = document.getElementById('item-column').value;
    
    if (!title) {
        alert('Le titre est requis');
        return;
    }
    
    if (!socket || !socket.connected) {
        alert('Non connecté au serveur');
        return;
    }
    
    if (editingItemId) {
        // Édition
        socket.emit('update_board_item', {
            id: editingItemId,
            title,
            content,
            assigned_to: assignedTo || null,
            column_name: column
        });
    } else {
        // Création
        socket.emit('create_board_item', {
            title,
            content,
            assigned_to: assignedTo || null,
            column: column
        });
    }
    
    closeItemModal();
}

// Éditer un item
function editItem(id) {
    const item = boardItems.find(i => i.id === id);
    if (!item) return;
    
    editingItemId = id;
    document.getElementById('modal-title').textContent = 'Éditer l\'item';
    document.getElementById('item-title').value = item.title;
    document.getElementById('item-content').value = item.content || '';
    document.getElementById('item-assigned').value = item.assigned_to || '';
    document.getElementById('item-column').value = item.column_name;
    document.getElementById('item-modal').classList.add('active');
}

// Supprimer un item
function deleteItem(id) {
    if (!confirm('Supprimer cet item ?')) return;
    
    if (!socket || !socket.connected) {
        alert('Non connecté au serveur');
        return;
    }
    
    socket.emit('delete_board_item', { id });
}

// Déplacer un item
function moveItem(id, direction) {
    const item = boardItems.find(i => i.id === id);
    if (!item) return;
    
    const columns = ['todo', 'inprogress', 'done'];
    const currentIndex = columns.indexOf(item.column_name);
    let newIndex;
    
    if (direction === 'left' && currentIndex > 0) {
        newIndex = currentIndex - 1;
    } else if (direction === 'right' && currentIndex < columns.length - 1) {
        newIndex = currentIndex + 1;
    } else {
        return;
    }
    
    if (!socket || !socket.connected) {
        alert('Non connecté au serveur');
        return;
    }
    
    socket.emit('update_board_item', {
        id,
        column_name: columns[newIndex]
    });
}
