const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { runTurn } = require('../chatbot-engine');

router.post('/message', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Chatbot chưa được cấu hình — thiếu ANTHROPIC_API_KEY trên máy chủ.' });
  }
  const { messages, userText, approveToolUseId, decision, pendingExtraResults } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'Thiếu lịch sử hội thoại (messages)' });

  // A confirm/cancel resume must never carry new user text too — the tool_result has to be the
  // very next message after the assistant's tool_use turn, with nothing interleaved.
  const msgs = messages.slice();
  if (userText && !approveToolUseId) msgs.push({ role: 'user', content: userText });

  try {
    const client = new Anthropic();
    const result = await runTurn({ messages: msgs, approveToolUseId, decision, pendingExtraResults, user: req.user, client });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Lỗi chatbot không xác định' });
  }
});

module.exports = router;
