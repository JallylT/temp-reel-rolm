const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const validator = require('validator');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Base de données SQLite
const db = new sqlite3.Database('./chat.db', (err) => {
  if (err) {
    console.error('Erreur connexion DB:', err.message);
  } else {
    console.log('Connecté à la base de données SQLite');
  }
});

// Initialisation des tables
db.serialize(() => {
  // Table utilisateurs
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Table messages
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Table monitoring
  db.run(`CREATE TABLE IF NOT EXISTS connection_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Table board items
  db.run(`CREATE TABLE IF NOT EXISTS board_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT,
    username TEXT NOT NULL,
    assigned_to TEXT,
    column_name TEXT DEFAULT 'todo',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Monitoring
const monitoring = {
  activeConnections: 0,
  totalConnections: 0,
  messagesCount: 0
};

// Rate limiting par utilisateur
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 1000; // 1 seconde
const MAX_MESSAGES_PER_WINDOW = 5;

function checkRateLimit(username) {
  const now = Date.now();
  const userLimits = rateLimits.get(username) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
  
  if (now > userLimits.resetTime) {
    rateLimits.set(username, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  if (userLimits.count >= MAX_MESSAGES_PER_WINDOW) {
    return false;
  }
  
  userLimits.count++;
  rateLimits.set(username, userLimits);
  return true;
}

// Sanitisation des entrées
function sanitizeInput(input) {
  if (!input || typeof input !== 'string') return '';
  return validator.escape(input.trim().substring(0, 500));
}

// Validation du pseudo
function validateUsername(username) {
  if (!username || typeof username !== 'string') return false;
  if (username.length < 3 || username.length > 20) return false;
  return /^[a-zA-Z0-9_-]+$/.test(username);
}

// API REST - Inscription/Connexion
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validation
    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Pseudo invalide (3-20 caractères alphanumériques)' });
    }

    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Mot de passe trop court (min 4 caractères)' });
    }

    // Hash du mot de passe
    const passwordHash = await bcrypt.hash(password, 10);
    const token = uuidv4();

    db.run(
      'INSERT INTO users (username, password_hash, token) VALUES (?, ?, ?)',
      [username, passwordHash, token],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Ce pseudo est déjà pris' });
          }
          return res.status(500).json({ error: 'Erreur serveur' });
        }
        res.json({ success: true, token, username });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Pseudo invalide' });
    }

    db.get(
      'SELECT * FROM users WHERE username = ?',
      [username],
      async (err, user) => {
        if (err) {
          return res.status(500).json({ error: 'Erreur serveur' });
        }

        if (!user) {
          return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect' });
        }

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
          return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect' });
        }

        // Générer un nouveau token
        const token = uuidv4();
        db.run('UPDATE users SET token = ? WHERE id = ?', [token, user.id]);

        res.json({ success: true, token, username: user.username });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Vérification du token
function verifyToken(token, callback) {
  db.get('SELECT username FROM users WHERE token = ?', [token], (err, user) => {
    if (err || !user) {
      callback(false, null);
    } else {
      callback(true, user.username);
    }
  });
}

// Socket.IO - Temps réel
io.on('connection', (socket) => {
  console.log(`Nouvelle connexion: ${socket.id}`);
  monitoring.totalConnections++;
  
  let authenticatedUsername = null;

  // Authentification Socket
  socket.on('authenticate', (data) => {
    const { token } = data;
    
    verifyToken(token, (isValid, username) => {
      if (isValid) {
        authenticatedUsername = username;
        socket.username = username;
        monitoring.activeConnections++;

        // Log de connexion
        db.run('INSERT INTO connection_logs (username, action) VALUES (?, ?)', [username, 'connect']);

        socket.emit('authenticated', { success: true, username });
        
        // Envoyer l'historique des messages
        db.all('SELECT username, content, timestamp FROM messages ORDER BY id DESC LIMIT 50', [], (err, rows) => {
          if (!err) {
            socket.emit('message_history', rows.reverse());
          }
        });

        // Notifier tout le monde
        broadcastUserList();
        io.emit('user_joined', { username });

        console.log(`${username} authentifié`);
      } else {
        socket.emit('authenticated', { success: false, error: 'Token invalide' });
        socket.disconnect();
      }
    });
  });

  // Réception d'un message
  socket.on('send_message', (data) => {
    if (!authenticatedUsername) {
      socket.emit('error', { message: 'Non authentifié' });
      return;
    }

    // Rate limiting
    if (!checkRateLimit(authenticatedUsername)) {
      socket.emit('error', { message: 'Trop de messages. Ralentissez!' });
      return;
    }

    const content = sanitizeInput(data.content);
    
    if (!content || content.length === 0) {
      socket.emit('error', { message: 'Message vide' });
      return;
    }

    const timestamp = new Date().toISOString();
    
    // Sauvegarder en DB
    db.run(
      'INSERT INTO messages (username, content, timestamp) VALUES (?, ?, ?)',
      [authenticatedUsername, content, timestamp],
      function(err) {
        if (err) {
          console.error('Erreur sauvegarde message:', err);
          return;
        }

        monitoring.messagesCount++;

        // Broadcast à tous les clients
        io.emit('new_message', {
          id: this.lastID,
          username: authenticatedUsername,
          content,
          timestamp
        });

        console.log(`${authenticatedUsername}: ${content}`);
      }
    );
  });

  // Demande de monitoring
  socket.on('get_monitoring', () => {
    if (!authenticatedUsername) return;
    
    socket.emit('monitoring_data', {
      activeConnections: monitoring.activeConnections,
      totalConnections: monitoring.totalConnections,
      messagesCount: monitoring.messagesCount
    });
  });

  // Ping pour mesurer la latence
  socket.on('ping_latency', (timestamp) => {
    socket.emit('pong_latency', timestamp);
  });

  // Déconnexion
  socket.on('disconnect', () => {
    if (authenticatedUsername) {
      monitoring.activeConnections--;
      
      db.run('INSERT INTO connection_logs (username, action) VALUES (?, ?)', [authenticatedUsername, 'disconnect']);
      
      io.emit('user_left', { username: authenticatedUsername });
      broadcastUserList();
      
      console.log(`${authenticatedUsername} déconnecté`);
    }
  });

  // ========== BOARD EVENTS ==========

  // Récupérer les utilisateurs connectés (pour assignation)
  socket.on('get_connected_users', () => {
    if (!authenticatedUsername) return;

    const connectedUsers = [];
    for (let [id, socket] of io.of("/").sockets) {
      if (socket.username) {
        connectedUsers.push(socket.username);
      }
    }
    socket.emit('connected_users', connectedUsers);
  });

  // Récupérer tous les items du board
  socket.on('get_board_items', () => {
    if (!authenticatedUsername) return;

    db.all('SELECT * FROM board_items ORDER BY id ASC', [], (err, rows) => {
      if (!err) {
        socket.emit('board_items', rows);
      }
    });
  });

  // Créer un nouvel item
  socket.on('create_board_item', (data) => {
    if (!authenticatedUsername) return;

    const title = sanitizeInput(data.title);
    const content = sanitizeInput(data.content || '');
    const columnName = data.column || 'todo';
    const assignedTo = data.assigned_to || null;

    if (!title) {
      socket.emit('error', { message: 'Titre requis' });
      return;
    }

    const timestamp = new Date().toISOString();
    db.run(
      'INSERT INTO board_items (title, content, username, assigned_to, column_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [title, content, authenticatedUsername, assignedTo, columnName, timestamp, timestamp],
      function(err) {
        if (err) {
          console.error('Erreur création item:', err);
          return;
        }

        const newItem = {
          id: this.lastID,
          title,
          content,
          username: authenticatedUsername,
          assigned_to: assignedTo,
          column_name: columnName,
          created_at: timestamp,
          updated_at: timestamp
        };

        io.emit('board_item_created', newItem);
        console.log(`${authenticatedUsername} a créé: ${title}`);
      }
    );
  });

  // Mettre à jour un item (déplacement ou édition)
  socket.on('update_board_item', (data) => {
    if (!authenticatedUsername) return;

    const { id, title, content, column_name, assigned_to } = data;
    const timestamp = new Date().toISOString();

    let updateFields = ['updated_at = ?'];
    let updateValues = [timestamp];

    if (title !== undefined) {
      updateFields.push('title = ?');
      updateValues.push(sanitizeInput(title));
    }
    if (content !== undefined) {
      updateFields.push('content = ?');
      updateValues.push(sanitizeInput(content));
    }
    if (column_name !== undefined) {
      updateFields.push('column_name = ?');
      updateValues.push(column_name);
    }
    if (assigned_to !== undefined) {
      updateFields.push('assigned_to = ?');
      updateValues.push(assigned_to);
    }

    updateValues.push(id);

    db.run(
      `UPDATE board_items SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues,
      function(err) {
        if (err) {
          console.error('Erreur mise à jour item:', err);
          return;
        }

        io.emit('board_item_updated', { id, title, content, column_name, assigned_to, updated_at: timestamp });
        console.log(`${authenticatedUsername} a modifié item #${id}`);
      }
    );
  });

  // Supprimer un item
  socket.on('delete_board_item', (data) => {
    if (!authenticatedUsername) return;

    const { id } = data;

    db.run('DELETE FROM board_items WHERE id = ?', [id], function(err) {
      if (err) {
        console.error('Erreur suppression item:', err);
        return;
      }

      io.emit('board_item_deleted', { id });
      console.log(`${authenticatedUsername} a supprimé item #${id}`);
    });
  });
});

// Envoyer la liste des utilisateurs connectés
function broadcastUserList() {
  const connectedUsers = [];
  for (let [id, socket] of io.of("/").sockets) {
    if (socket.username) {
      connectedUsers.push(socket.username);
    }
  }
  io.emit('user_list', { users: connectedUsers });
  io.emit('connected_users', connectedUsers);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
====================================
  Serveur temps réel démarré
  Port: ${PORT}
  WebSocket: Socket.IO actif
  Base de données: SQLite
====================================
  `);
});
