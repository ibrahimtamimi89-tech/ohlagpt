const messagesEl = document.getElementById('messages');
const questionEl = document.getElementById('question');
const sendBtn = document.getElementById('sendBtn');

function addMessage(content, fromUser = false) {
  const div = document.createElement('div');
  div.className = 'msg ' + (fromUser ? 'user' : 'bot');
  div.textContent = content;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

sendBtn.addEventListener('click', async () => {
  const message = questionEl.value.trim();
  if (!message) return;
  addMessage(message, true);
  questionEl.value = '';

  addMessage('Thinking...');

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  const data = await res.json();
  messagesEl.lastChild.textContent = data.reply || data.error || 'No response';
});
