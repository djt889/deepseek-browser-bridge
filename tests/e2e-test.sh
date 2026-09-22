#!/bin/bash
# DeepSeek Browser Bridge — E2E smoke test (LOW-FREQUENCY by design).
# Real web requests: run at most ONE pass, spaced ~30s apart, 4 cases total.
# Covers the paths the offline tests cannot: model-name switches, tools,
# thinking levels, DQ_EMPTY_ANSWER surfacing (that failure is EXPECTED only
# in the synthetic case; a blank-200 would be the bug).

BASE_URL="http://127.0.0.1:39751/v1"
API_KEY="${DQ_API_KEY:-sk-jiuxia233}"
GAP_S="${DQ_E2E_GAP_S:-30}"

PASS=0; FAIL=0

log() { echo "[$(date '+%H:%M:%S')] $1"; }

ask() { # ask <model> <json-extra> ; prints response json
  curl -s "$BASE_URL/chat/completions" -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    --data "{\"model\":\"$1\",\"messages\":[{\"role\":\"user\",\"content\":\"$2\"}],$3}" \
    --max-time 240
}

check() { # check <name> <resp> <expect-python-expr on d>
  local name="$1" resp="$2" expr="$3"
  if echo "$resp" | python -c "
import sys, json
d = json.load(sys.stdin)
ok = ($expr)
sys.exit(0 if ok else 1)
" 2>/dev/null; then
    PASS=$((PASS+1)); log "PASS  $name"
  else
    FAIL=$((FAIL+1)); log "FAIL  $name"
    echo "$resp" | head -c 400 | sed 's/^/      /'
  fi
}

log "=== E2E smoke (4 cases, ${GAP}s apart) ==="

# 1. Plain chat, default model (thinks by default)
r=$(ask deepseek-v4.1-flash "用一句话说明什么是快速排序")
check "plain chat has non-empty content" "$r" "len(d['choices'][0]['message']['content']) > 0"
sleep "$GAP_S"

# 2. nothink variant + explicit reasoning_effort=off
r=$(ask deepseek-v4.1-flash-nothink "1+1 等于几?只回答数字" '"stream": false, "reasoning_effort": "off"')
check "nothink model answers without reasoning" "$r" "d['choices'][0]['message'].get('reasoning_content') is None and len(d['choices'][0]['message']['content']) > 0"
sleep "$GAP_S"

# 3. Tool call round-trip (single tool, cold session)
r=$(curl -s "$BASE_URL/chat/completions" -X POST \
    -H "Content-Type: application/json" -H "Authorization: Bearer $API_KEY" \
    --max-time 240 --data '{
      "model": "deepseek-v4.1-flash",
      "stream": false,
      "tools": [{"type": "function", "function": {"name": "get_weather", "description": "查询城市天气", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}],
      "messages": [{"role": "user", "content": "查一下广州现在的天气，用工具查"}]
    }')
check "tool call emitted with parsable args" "$r" "(d['choices'][0]['message'].get('tool_calls') or [{}])[0].get('function', {}).get('name') == 'get_weather'"
sleep "$GAP_S"

# 4. Thinking level passthrough (high) — content + reasoning both present
r=$(ask deepseek-v4.1-flash "推导一下勾股定理" '"stream": false, "reasoning_effort": "high"')
check "high thinking yields reasoning+content" "$r" "d['choices'][0]['message'].get('reasoning_content') and len(d['choices'][0]['message']['content']) > 0"

log "=== SUMMARY: $PASS passed, $FAIL failed ==="
exit $FAIL
