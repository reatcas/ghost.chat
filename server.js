/* jshint asi: true */
/* jshint esnext: true */

var fs = require('fs')
var ws = require('ws')
var crypto = require('crypto')


var config = {}









function loadConfig(filename) {
	try {
		var data = fs.readFileSync(filename, 'utf8')
		config = JSON.parse(data)
		console.log("Loaded config '" + filename + "'")
	}
	catch (e) {
		console.warn(e)
	}
}

var configFilename = 'config.json'
loadConfig(configFilename)
fs.watchFile(configFilename, {persistent: false}, function() {
	loadConfig(configFilename)
})


var server = new ws.Server({host: config.host, port: config.port})
console.log("Servidor iniciado en " + config.host + ":" + config.port)

server.on('connection', function(socket) {
	socket.on('message', function(data) {
		try {
			// Don't penalize yet, but check whether IP is rate-limited
			if (POLICE.frisk(getAddress(socket), 0)) {
				send({cmd: 'warn', text: "Tu IP está limitada o bloqueada."}, socket)
				return
			}
			// Penalize here, but don't do anything about it
			POLICE.frisk(getAddress(socket), 1)

			// ignore ridiculously large packets
			if (data.length > 65536) {
				return
			}
			var args = JSON.parse(data)
			var cmd = args.cmd
			var command = COMMANDS[cmd]
			if (command && args) {
				command.call(socket, args)
			}
		}
		catch (e) {
			console.warn(e.stack)
		}
	})

	socket.on('close', function() {
		try {
			if (socket.channel) {
				broadcast({cmd: 'onlineRemove', nick: socket.nick}, socket.channel)
			}
		}
		catch (e) {
			console.warn(e.stack)
		}
	})
})

function send(data, client) {
	// Add timestamp to command
	data.time = Date.now()
	try {
		if (client.readyState == ws.OPEN) {
			client.send(JSON.stringify(data))
		}
	}
	catch (e) {
		// Ignore exceptions thrown by client.send()
	}
}

/** Sends data to all clients
channel: if not null, restricts broadcast to clients in the channel
*/
function broadcast(data, channel) {
	for (var client of server.clients) {
		if (channel ? client.channel === channel : client.channel) {
			send(data, client)
		}
	}
}

function nicknameValid(nick) {
	// Allow letters, numbers, and underscores
	return /^[a-zA-Z0-9_]{1,24}$/.test(nick)
}

function getAddress(client) {
	if (config.x_forwarded_for) {
		// The remoteAddress is 127.0.0.1 since if all connections
		// originate from a proxy (e.g. nginx).
		// You must write the x-forwarded-for header to determine the
		// client's real IP address.
		return client.upgradeReq.headers['x-forwarded-for']
	}
	else {
		return client.upgradeReq.connection.remoteAddress
	}
}

function hash(password) {
	var sha = crypto.createHash('sha256')
	sha.update(password + config.salt)
	return sha.digest('base64').substr(0, 6)
}

function isAdmin(client) {
	return client.nick == config.admin
}

function isMod(client) {
	if (isAdmin(client)) return true
	if (config.mods) {
		if (client.trip && config.mods.indexOf(client.trip) > -1) {
			return true
		}
	}
	return false
}


// `this` bound to client
var COMMANDS = {
	ping: function() {
		// Don't do anything
	},

	join: function(args) {
		var channel = String(args.channel)
		var nick = String(args.nick)

		if (POLICE.frisk(getAddress(this), 3)) {
			send({cmd: 'warn', text: "Estás ingresando a canales muy rápido. Espera un momento e intenta de nuevo."}, this)
			return
		}

		if (this.nick) {
			// Already joined
			return
		}

		// Process channel name
		channel = channel.trim()
		if (!channel) {
			// Must join a non-blank channel
			return
		}

		// Process nickname
		var nickArr = nick.split('#', 2)
		nick = nickArr[0].trim()

		if (!nicknameValid(nick)) {
			send({cmd: 'warn', text: "Tu Nombre debe contener al menos 24 letras, numeros, y guiones"}, this)
			return
		}

		var password = nickArr[1]
		if (nick.toLowerCase() == config.admin.toLowerCase()) {
			if (password != config.password) {
				send({cmd: 'warn', text: "No puedes suplantar al administrador"}, this)
				return
			}
		}
		else if (password) {
			this.trip = hash(password)
		}

		var address = getAddress(this)
		for (var client of server.clients) {
			if (client.channel === channel) {
				if (client.nick.toLowerCase() === nick.toLowerCase()) {
					send({cmd: 'warn', text: "El nombre elegido ya existe"}, this)
					return
				}
			}
		}

		// Announce the new user
		broadcast({cmd: 'onlineAdd', nick: nick}, channel)

		// Formally join channel
		this.channel = channel
		this.nick = nick

		// Set the online users for new user
		var nicks = []
		for (var client of server.clients) {
			if (client.channel === channel) {
				nicks.push(client.nick)
			}
		}
		send({cmd: 'onlineSet', nicks: nicks}, this)
	},

	chat: function(args) {
		var text = String(args.text)

		if (!this.channel) {
			return
		}
		// strip newlines from beginning and end
		text = text.replace(/^\s*\n|^\s+$|\n\s*$/g, '')
		// replace 3+ newlines with just 2 newlines
		text = text.replace(/\n{3,}/g, "\n\n")
		if (!text) {
			return
		}

		var score = text.length / 83 / 4
		if (POLICE.frisk(getAddress(this), score)) {
			send({cmd: 'warn', text: "Estás enviando demasiado texto. Espera un momento e intenta de nuevo.\nUsa las flechas para restaurar el mensaje anterior."}, this)
			return
		}

		var data = {cmd: 'chat', nick: this.nick, text: text}
		if (isAdmin(this)) {
			data.admin = true
		}
		else if (isMod(this)) {
			data.mod = true
		}
		if (this.trip) {
			data.trip = this.trip
		}
		broadcast(data, this.channel)
	},

	invite: function(args) {
		var nick = String(args.nick)
		if (!this.channel) {
			return
		}

		if (POLICE.frisk(getAddress(this), 2)) {
			send({cmd: 'warn', text: "Estás enviando invitaciones muy rápido. Espera antes de intentar de nuevo."}, this)
			return
		}

		var friend
		for (var client of server.clients) {
			// Find friend's client
			if (client.channel == this.channel && client.nick == nick) {
				friend = client
				break
			}
		}
		if (!friend) {
			send({cmd: 'warn', text: "Usuario no encontrado en el canal"}, this)
			return
		}
		if (friend == this) {
			// Ignore silently
			return
		}
		var channel = Math.random().toString(36).substr(2, 8)
		send({cmd: 'info', text: "Invitaste a " + friend.nick + " al canal ?" + channel}, this)
		send({cmd: 'info', text: this.nick + " te invitó al canal ?" + channel}, friend)
	},

	stats: function(args) {
		var ips = {}
		var channels = {}
		for (var client of server.clients) {
			if (client.channel) {
				channels[client.channel] = true
				ips[getAddress(client)] = true
			}
		}
		send({cmd: 'info', text: Object.keys(ips).length + " IP únicas en " + Object.keys(channels).length + " canales"}, this)
	},

	// Moderator-only commands below this point

	ban: function(args) {
		if (!isMod(this)) {
			return
		}

		var nick = String(args.nick)
		if (!this.channel) {
			return
		}

		var badClient = server.clients.filter(function(client) {
			return client.channel == this.channel && client.nick == nick
		}, this)[0]

		if (!badClient) {
			send({cmd: 'warn', text: "No encontramos a " + nick}, this)
			return
		}

		if (isMod(badClient)) {
			send({cmd: 'warn', text: "No puedes banear al moderador"}, this)
			return
		}

		POLICE.arrest(getAddress(badClient))
		console.log(this.nick + " [" + this.trip + "] bloqueado " + nick + " en " + this.channel)
		broadcast({cmd: 'info', text: "Bloqueado " + nick}, this.channel)
	},

	unban: function(args) {
		if (!isMod(this)) {
			return
		}

		var ip = String(args.ip)
		if (!this.channel) {
			return
		}

		POLICE.pardon(ip)
		console.log(this.nick + " [" + this.trip + "] desbloqueado " + ip + " in " + this.channel)
		send({cmd: 'info', text: "Desbloqueado " + ip}, this)
	},

	// Admin-only commands below this point

	listUsers: function() {
		if (!isAdmin(this)) {
			return
		}
		var channels = {}
		for (var client of server.clients) {
			if (client.channel) {
				if (!channels[client.channel]) {
					channels[client.channel] = []
				}
				channels[client.channel].push(client.nick)
			}
		}

		var lines = []
		for (var channel in channels) {
			lines.push("?" + channel + " " + channels[channel].join(", "))
		}
		var text = server.clients.length + " usuarios activos:\n\n"
		text += lines.join("\n")
		send({cmd: 'info', text: text}, this)
	},

	broadcast: function(args) {
		if (!isAdmin(this)) {
			return
		}
		var text = String(args.text)
		broadcast({cmd: 'info', text: "Servidor: " + text})
	},
}


// rate limiter
var POLICE = {
	records: {},
	halflife: 30000, // ms
	threshold: 15,

	loadJail: function(filename) {
		var ids
		try {
			var text = fs.readFileSync(filename, 'utf8')
			ids = text.split(/\r?\n/)
		}
		catch (e) {
			return
		}
		for (var id of ids) {
			if (id && id[0] != '#') {
				this.arrest(id)
			}
		}
		console.log("Loaded jail '" + filename + "'")
	},

	search: function(id) {
		var record = this.records[id]
		if (!record) {
			record = this.records[id] = {
				time: Date.now(),
				score: 0,
			}
		}
		return record
	},

	frisk: function(id, deltaScore) {
		var record = this.search(id)
		if (record.arrested) {
			return true
		}

		record.score *= Math.pow(2, -(Date.now() - record.time)/POLICE.halflife)
		record.score += deltaScore
		record.time = Date.now()
		if (record.score >= this.threshold) {
			return true
		}
		return false
	},

	arrest: function(id) {
		var record = this.search(id)
		if (record) {
			record.arrested = true
		}
	},

	pardon: function(id) {
		var record = this.search(id)
		if (record) {
			record.arrested = false
		}
	},
}

POLICE.loadJail('jail.txt')