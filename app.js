
const socket = io();

const $ = id => document.getElementById(id);

let myRoom = null;
let myId = null;
let host = false;
let players = [];
let phase = 'lobby';
let myRole = null;
let questionTotal = 3;
let questionNo = 1;
let myTurn = false;
let alreadyAnswered = false;
let alreadyVoted = false;

const show = (id, on = true) =>
  $(id).classList.toggle('hidden', !on);

function toast(msg) {
  $('toast').textContent = msg;
  show('toast');
  setTimeout(() => show('toast', false), 2600);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function parseCategories() {
  const out = {};

  $('categories').value.split('\n').forEach(line => {
    const i = line.indexOf(':');

    if (i > 0) {
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1)
        .split(',')
        .map(x => x.trim())
        .filter(Boolean);

      if (k && v.length) out[k] = v;
    }
  });

  return out;
}

function enterLobby() {
  show('home', false);
  show('lobby');
  show('game', false);
}

function createGameElements() {
  if (!$('turnInfo')) {
    const turn = document.createElement('div');
    turn.id = 'turnInfo';
    turn.className = 'rolecard';
    turn.style.marginTop = '16px';
    turn.style.textAlign = 'center';
    $('questionArea').prepend(turn);
  }

  if (!$('answerReveal')) {
    const reveal = document.createElement('div');
    reveal.id = 'answerReveal';
    reveal.className = 'rolecard';
    reveal.style.marginTop = '12px';
    reveal.style.background = 'rgba(70,130,255,0.12)';
    reveal.style.textAlign = 'center';
    $('questionArea').appendChild(reveal);
  }
}

createGameElements();

$('create').onclick = () =>
  socket.emit('room:create', { name: $('name').value });

$('showJoin').onclick = () => show('joinBox');

$('join').onclick = () =>
  socket.emit('room:join', {
    name: $('name').value,
    code: $('roomCode').value
  });

$('roomCode').oninput = e =>
  e.target.value = e.target.value.toUpperCase();

$('copy').onclick = () => {
  if (myRoom) {
    navigator.clipboard?.writeText(myRoom)
      .then(() => toast('Código copiado!'))
      .catch(() => toast('Não foi possível copiar.'));
  }
};

$('saveSettings').onclick = () =>
  socket.emit('settings:update', {
    categories: parseCategories(),
    questions: $('questions').value,
    impostors: $('impostors').value
  });

$('start').onclick = () => socket.emit('game:start');

$('sendAnswer').onclick = () => {
  const answer = $('answer').value.trim();

  if (!answer) return toast('Digite sua resposta.');
  if (!myTurn || alreadyAnswered) return;

  alreadyAnswered = true;
  myTurn = false;

  socket.emit('question:answer', { answer });

  $('answer').disabled = true;
  $('sendAnswer').disabled = true;
  $('answerStatus').textContent = 'Resposta enviada!';
};

socket.on('connect', () => {
  myId = socket.id;
});

socket.on('error:msg', toast);

socket.on('room:update', r => {
  myRoom = r.code;
  host = r.host === myId;
  players = r.players;
  phase = r.phase;

  if (phase === 'lobby') {
    enterLobby();

    $('code').textContent = r.code;
    $('playerCount').textContent = `(${r.players.length})`;

    $('players').innerHTML = r.players.map((p, i) => `
      <div class="player">
        <span class="avatar">${['🐦','🦊','🐸','🐼','🐙','🦄'][i % 6]}</span>
        <b>${esc(p.name)}</b>
        ${p.id === r.host ? '<span class="muted"> · anfitrião</span>' : ''}
      </div>
    `).join('');

    show('hostSettings', host);
    show('waiting', !host);
  }
});

socket.on('game:role', r => {
  myRole = r;
  questionTotal = r.questions;

  alreadyAnswered = false;
  alreadyVoted = false;
  myTurn = false;

  show('lobby', false);
  show('game');
  show('questionArea', false);
  show('voteArea', false);
  show('resultArea', false);

  $('answerReveal').textContent = '';
  $('phaseLabel').textContent = 'SUA FUNÇÃO';

  $('roleCard').className =
    'rolecard ' + (r.role === 'impostor' ? 'impostor' : '');

  $('roleCard').innerHTML = r.role === 'impostor'
    ? `
      <div>🚨</div>
      <h2>VOCÊ É O IMPOSTOR!</h2>
      <p>Descubra a palavra sem ser descoberto.</p>
      <div class="word">🤫</div>
    `
    : `
      <div>🔐 SUA PALAVRA SECRETA</div>
      <div class="word">${esc(r.word)}</div>
      <p>Categoria: ${esc(r.category)}</p>
      <small>Não conte a palavra para ninguém!</small>
    `;
});

socket.on('game:phase', p => {
  phase = p.phase;

  if (p.phase === 'questions') {
    questionNo = p.question;
    myTurn = p.targetId === myId;
    alreadyAnswered = false;

    $('phaseLabel').textContent = 'RODADA DE PERGUNTAS';

    $('questionTitle').textContent =
      `Pergunta ${questionNo} de ${questionTotal}`;

    $('turnInfo').innerHTML = `
      <div style="font-size:13px;opacity:.7">VEZ DE RESPONDER</div>
      <h2 style="margin:8px 0">${esc(p.targetName)}</h2>
      <div>${myTurn ? '🎤 É a sua vez!' : '👀 Aguarde sua vez...'}</div>
    `;

    $('answer').value = '';
    $('answer').disabled = !myTurn;
    $('sendAnswer').disabled = !myTurn;

    $('answer').placeholder = myTurn
      ? 'Sua resposta...'
      : 'Aguarde o jogador responder...';

    $('answerStatus').textContent = myTurn
      ? 'É sua vez de responder!'
      : 'Esperando a resposta do jogador...';

    show('questionArea');
    show('voteArea', false);
    show('resultArea', false);
  }

  if (p.phase === 'voting') {
    myTurn = false;
    alreadyVoted = false;

    show('questionArea', false);
    show('voteArea');
    show('resultArea', false);

    $('voteList').innerHTML = players.map(p => `
      <button class="voteButton" data-id="${p.id}">
        🗳️ ${esc(p.name)}
      </button>
    `).join('');

    $('voteList').querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        if (alreadyVoted) return;

        alreadyVoted = true;

        socket.emit('vote:cast', {
          targetId: b.dataset.id
        });

        $('voteList').querySelectorAll('button').forEach(x => {
          x.disabled = true;
        });

        $('voteStatus').textContent =
          'Voto registrado. Esperando os outros...';
      };
    });
  }
});

// Todos recebem a resposta enviada.
socket.on('question:answered', data => {
  $('answerReveal').innerHTML = `
    <div style="font-size:13px;opacity:.7">RESPOSTA DE ${esc(data.playerName)}</div>
    <h2 style="margin:8px 0">${esc(data.answer)}</h2>
  `;
});

socket.on('vote:progress', p => {
  $('voteStatus').textContent =
    `${p.count} de ${p.total} votos registrados.`;
});

socket.on('game:result', r => {
  show('questionArea', false);
  show('voteArea', false);
  show('resultArea');

  $('phaseLabel').textContent = 'FIM DA RODADA';

  $('resultArea').innerHTML = `
    <h2>${r.caught
      ? '🎉 Impostor descoberto!'
      : '😈 O impostor escapou!'}</h2>

    <p class="muted">
      A palavra era <b>${esc(r.word)}</b>
      (${esc(r.category)}).
    </p>

    <p>Impostor(es):
      <b>${r.impostors.map(esc).join(', ')}</b>
    </p>

    <p>Mais votado(s):
      <b>${r.eliminated.map(esc).join(', ') || 'Ninguém'}</b>
    </p>

    ${host
      ? '<button id="again" class="primary full">Nova partida</button>'
      : '<p class="muted">Esperando o anfitrião iniciar outra partida...</p>'}
  `;

  if (host) {
    $('again').onclick = () => socket.emit('game:again');
  }
});
