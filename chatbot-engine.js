// Agentic tool-calling loop for the chatbot, kept separate from routes/chat.js (thin Express glue)
// so it can be exercised directly in tests with a mock `client` — mirrors how fail2ban-manager.js
// holds real logic while routes/security.js is just the HTTP wrapper around it.
const { TOOLS, TOOLS_BY_NAME, hasPermission } = require('./chatbot-tools');

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 1500;
const MAX_ROUNDS = 8; // safety cap — a well-behaved loop finishes in 1-3 rounds

const SYSTEM_PROMPT = `Bạn là trợ lý AI của NetAdmin Pro — hệ thống giám sát máy chủ, thiết bị mạng, VM vCenter, uptime website và cảnh báo. Người dùng sẽ hỏi thông tin hoặc yêu cầu thực hiện hành động bằng tiếng Việt tự nhiên.

QUY TẮC BẮT BUỘC:
- Luôn dùng tool để lấy dữ liệu thật, không tự đoán hoặc bịa số liệu/trạng thái.
- Mỗi lượt CHỈ gọi 1 tool. Nếu cần nhiều bước, thực hiện tuần tự qua nhiều lượt.
- Nếu tên máy chủ/VM/thiết bị người dùng nhắc đến không rõ ràng, hoặc tool trả về nhiều kết quả khớp (ambiguous/candidates), hãy hỏi lại người dùng để xác định chính xác 1 đối tượng — KHÔNG tự chọn đại.
- Trước khi gọi 1 tool thay đổi hạ tầng (enable_fail2ban, disable_fail2ban, acknowledge_alert, resolve_alert), phải chắc chắn đã xác định đúng 1 đối tượng cụ thể. Hệ thống sẽ tự động hiển thị bước xác nhận cho người dùng trước khi thực thi thật, nên bạn không cần tự hỏi lại "bạn có chắc không" trong câu trả lời — chỉ cần mô tả ngắn gọn bạn sắp làm gì.
- Nếu 1 tool trả về lỗi "không có quyền", hãy thông báo lại cho người dùng bằng tiếng Việt rằng họ không có quyền thực hiện hành động đó, không thử lại.
- Trả lời ngắn gọn, rõ ràng, bằng tiếng Việt.`;

const ANTHROPIC_TOOLS = TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

function textOf(content) {
  const block = (content || []).find(b => b.type === 'text');
  return block ? block.text : '';
}

async function buildToolResult(block, user) {
  const tool = TOOLS_BY_NAME[block.name];
  if (!tool) {
    return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: `Không có tool "${block.name}"` }), is_error: true };
  }
  if (!hasPermission(user, tool.permission)) {
    return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: 'Bạn không có quyền thực hiện hành động này.' }), is_error: true };
  }
  try {
    const result = await tool.execute(block.input || {}, user);
    return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
  } catch (e) {
    return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: e.message }), is_error: true };
  }
}

// `client` is injected (not constructed here) so tests can pass a mock with a fake
// messages.create() instead of hitting the real Anthropic API.
// `pendingExtraResults` only matters in the rare case the model calls >1 tool in a turn where the
// first happens to be mutating — see the pause branch below for why they need to travel together.
async function runTurn({ messages, approveToolUseId, decision, pendingExtraResults, user, client }) {
  const msgs = messages.slice();

  if (approveToolUseId) {
    const lastMsg = msgs[msgs.length - 1];
    const block = lastMsg?.content?.find(b => b.type === 'tool_use' && b.id === approveToolUseId);
    if (!block) throw Object.assign(new Error('Không tìm thấy hành động đang chờ xác nhận'), { status: 400 });
    const toolResult = decision === 'confirm'
      ? await buildToolResult(block, user)
      : { type: 'tool_result', tool_use_id: approveToolUseId, content: JSON.stringify({ cancelled: true, message: 'Người dùng đã hủy hành động này.' }) };
    const extra = Array.isArray(pendingExtraResults) ? pendingExtraResults : [];
    msgs.push({ role: 'user', content: [...extra, toolResult] });
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, tools: ANTHROPIC_TOOLS, messages: msgs
    });

    if (response.stop_reason !== 'tool_use') {
      msgs.push({ role: 'assistant', content: response.content });
      return { done: true, messages: msgs, text: textOf(response.content) };
    }

    msgs.push({ role: 'assistant', content: response.content });
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const first = toolUseBlocks[0];
    const tool = TOOLS_BY_NAME[first.name];

    if (tool && tool.mutating && hasPermission(user, tool.permission)) {
      const extraResults = toolUseBlocks.slice(1).map(block => ({
        type: 'tool_result', tool_use_id: block.id,
        content: JSON.stringify({ skipped: true, message: 'Bỏ qua — mỗi lượt chỉ xử lý 1 hành động, vui lòng thử lại sau khi hành động hiện tại hoàn tất.' })
      }));
      return {
        done: false, awaitingConfirm: true,
        toolUseId: first.id, toolName: first.name, input: first.input,
        summary: tool.summary(first.input),
        pendingExtraResults: extraResults,
        messages: msgs
      };
    }

    const results = [];
    for (const block of toolUseBlocks) results.push(await buildToolResult(block, user));
    msgs.push({ role: 'user', content: results });
  }

  throw Object.assign(new Error('Chatbot thực hiện quá nhiều bước liên tiếp, vui lòng thử lại.'), { status: 500 });
}

module.exports = { runTurn, MODEL, MAX_TOKENS, SYSTEM_PROMPT, ANTHROPIC_TOOLS };
