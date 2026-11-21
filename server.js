
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = new Map();

const code = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const clean = (s, max = 18) => String(s || '').trim().slice(0, max);

function publicRoom(r) {
  return {
    code: r.code,
    host: r.host,
    players: [...r.players.values()].map(p => ({
      id: p.id,
      name: p.name
    })),
    phase: r.phase,
    settings: r.settings
  };
}

function emitRoom(r) {
  io.to(r.code).emit('room:update', publicRoom(r));
}

function shuffle(list) {
  return [...list].sort(() => Math.random() - 0.5);
}

function leave(socket) {
  const c = socket.data.room;
  if (!c) return;

  const r = rooms.get(c);

  socket.leave(c);
  socket.data.room = null;

  if (!r) return;

  r.players.delete(socket.id);

  if (!r.players.size) {
    rooms.delete(c);
    return;
  }

  if (r.host === socket.id) {
    r.host = r.players.keys().next().value;
  }

  emitRoom(r);
}

function startQuestion(r) {
  if (r.round.questionIndex >= r.settings.questions) {
    r.phase = 'voting';
    io.to(r.code).emit('game:phase', { phase: 'voting' });
    emitRoom(r);
    return;
  }

  const targetId = r.round.questionOrder[r.round.questionIndex];
  const player = r.players.get(targetId);

  if (!player) {
    r.round.questionIndex++;
    return startQuestion(r);
  }

  io.to(r.code).emit('game:phase', {
    phase: 'questions',
    question: r.round.questionIndex + 1,
    total: r.settings.questions,
    targetId,
    targetName: player.name
  });
}

io.on('connection', socket => {

  socket.on('room:create', ({ name } = {}) => {
    name = clean(name);

    if (!name) {
      return socket.emit('error:msg', 'Digite seu nome.');
    }

    leave(socket);

    let c;
    do {
      c = code();
    } while (rooms.has(c));

    const r = {
      code: c,
      host: socket.id,
      players: new Map(),
      phase: 'lobby',
      settings: {
        categories: {
          Comidas: ['Pizza', 'Hambúrguer', 'Sushi'],
          Heróis: ['Homem-Aranha', 'Batman', 'Superman'],
          Personagens: ['Woody', 'Buzz', 'Sonic']
        },
        questions: 3,
        impostors: 1
      },
      round: null
    };

    r.players.set(socket.id, { id: socket.id, name });

    rooms.set(c, r);
    socket.join(c);
    socket.data.room = c;

    emitRoom(r);
  });

  socket.on('room:join', ({ name, code: c } = {}) => {
    name = clean(name);
    c = String(c || '').trim().toUpperCase();

    if (!name) {
      return socket.emit('error:msg', 'Digite seu nome.');
    }

    leave(socket);

    const r = rooms.get(c);

    if (!r) return socket.emit('error:msg', 'Sala não encontrada.');
    if (r.phase !== 'lobby') return socket.emit('error:msg', 'Partida iniciada.');
    if (r.players.size >= 12) return socket.emit('error:msg', 'Sala cheia.');

    r.players.set(socket.id, { id: socket.id, name });

    socket.join(c);
    socket.data.room = c;

    emitRoom(r);
  });

  socket.on('settings:update', ({ categories, questions, impostors } = {}) => {
    const r = rooms.get(socket.data.room);

    if (!r || r.host !== socket.id || r.phase !== 'lobby') return;

    const next = {};

    if (categories && typeof categories === 'object') {
      for (const [k, v] of Object.entries(categories).slice(0, 12)) {
        const cat = clean(k);
        const words = [...new Set(
          (Array.isArray(v) ? v : [])
            .map(word => clean(word))
            .filter(Boolean)
        )].slice(0, 40);

        if (cat && words.length) next[cat] = words;
      }
    }

    if (Object.keys(next).length) {
      r.settings.categories = next;
    }

    r.settings.questions = Math.max(1, Math.min(10, Number(questions) || 3));
    r.settings.impostors = Math.max(1, Math.min(4, Number(impostors) || 1));

    emitRoom(r);
  });

  socket.on('game:start', () => {
    const r = rooms.get(socket.data.room);

    if (!r || r.host !== socket.id || r.phase !== 'lobby') return;

    if (r.players.size < 3) {
      return socket.emit('error:msg', 'São necessários pelo menos 3 jogadores.');
    }

    const entries = Object.entries(r.settings.categories)
      .filter(([, words]) => words.length);

    if (!entries.length) {
      return socket.emit('error:msg', 'Adicione palavras.');
    }

    const [category, words] = entries[Math.floor(Math.random() * entries.length)];
    const word = words[Math.floor(Math.random() * words.length)];

    const ids = shuffle([...r.players.keys()]);
    const impostorCount = Math.min(r.settings.impostors, ids.length - 1);
    const impostorIds = new Set(ids.slice(0, impostorCount));

    // Cada pergunta recebe um jogador responsável.
    // Se houver mais perguntas que jogadores, a ordem recomeça.
    const order = shuffle([...r.players.keys()]);
    const questionOrder = Array.from(
      { length: r.settings.questions },
      (_, i) => order[i % order.length]
    );

    r.round = {
      category,
      word,
      impostorIds,
      questionIndex: 0,
      questionOrder,
      votes: {}
    };

    r.phase = 'questions';

    for (const [id] of r.players) {
      io.to(id).emit('game:role', {
        role: impostorIds.has(id) ? 'impostor' : 'player',
        word: impostorIds.has(id) ? null : word,
        category,
        questions: r.settings.questions
      });
    }

    startQuestion(r);
    emitRoom(r);
  });

  socket.on('question:answer', ({ answer } = {}) => {
    const r = rooms.get(socket.data.room);

    if (!r || r.phase !== 'questions' || !r.round) return;

    const targetId = r.round.questionOrder[r.round.questionIndex];

    // Só o jogador escolhido pode responder.
    if (socket.id !== targetId) return;

    answer = clean(answer, 120);
    if (!answer) return;

    const player = r.players.get(socket.id);
    if (!player) return;

    // A resposta fica visível para todos.
    io.to(r.code).emit('question:answered', {
      playerName: player.name,
      answer
    });

    r.round.questionIndex++;

    startQuestion(r);
    emitRoom(r);
  });

  socket.on('vote:cast', ({ targetId } = {}) => {
    const r = rooms.get(socket.data.room);

    if (!r || r.phase !== 'voting' || !r.round) return;
    if (!r.players.has(targetId)) return;
    if (r.round.votes[socket.id]) return;

    // Todos podem votar, inclusive no próprio nome.
    r.round.votes[socket.id] = targetId;

    const voteCount = Object.keys(r.round.votes).length;

    io.to(r.code).emit('vote:progress', {
      count: voteCount,
      total: r.players.size
    });

    if (voteCount === r.players.size) {
      r.phase = 'result';

      const tally = {};

      Object.values(r.round.votes).forEach(id => {
        tally[id] = (tally[id] || 0) + 1;
      });

      const max = Math.max(...Object.values(tally));
      const eliminated = Object.keys(tally).filter(id => tally[id] === max);

      io.to(r.code).emit('game:result', {
        impostors: [...r.round.impostorIds]
          .map(id => r.players.get(id)?.name)
          .filter(Boolean),
        word: r.round.word,
        category: r.round.category,
        eliminated: eliminated
          .map(id => r.players.get(id)?.name)
          .filter(Boolean),
        caught: eliminated.length === 1 &&
          r.round.impostorIds.has(eliminated[0])
      });

      emitRoom(r);
    }
  });

  socket.on('game:again', () => {
    const r = rooms.get(socket.data.room);

    if (!r || r.host !== socket.id || r.phase !== 'result') return;

    r.phase = 'lobby';
    r.round = null;

    emitRoom(r);
  });

  socket.on('disconnect', () => leave(socket));
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Loop Party rodando na porta ${PORT}`);
});
