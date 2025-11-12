const $ = (sel) => document.querySelector(sel);

const messagesEl = $('#messages');
const questionEl = $('#question');
const sendBtn = $('#sendBtn');

function addMsg(content, me = false) {
  const div = document.createElement('div');
  div.className = 'msg' + (me ? ' me' : '');
  div.textContent = content;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendQuestion() {
  const message = (questionEl.value || '').trim();
  if (!message) return;
  addMsg(message, true);
  questionEl.value = '';
  addMsg('Thinking…');
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    const data = await res.json();
    messagesEl.lastChild.textContent = data.reply || data.error || 'No reply';
  } catch {
    messagesEl.lastChild.textContent = 'Network error';
  }
}

sendBtn.addEventListener('click', sendQuestion);
questionEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion(); }
});

// clock
function updateClock() {
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  $('#clockTime').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  $('#clockDate').textContent = now.toLocaleDateString(undefined,{ weekday:'short', year:'numeric', month:'short', day:'numeric' });
}
updateClock(); setInterval(updateClock, 1000);
