#!/bin/bash

# DeepSeek Browser Bridge - End-to-End Real User Simulation Test
# Single run, comprehensive coverage, immediate bug audit on failure

BASE_URL="http://127.0.0.1:39751/v1"
API_KEY="sk-jiuxia233"
RESULTS_DIR="/tmp/e2e-tests-$(date +%s)"
mkdir -p "$RESULTS_DIR"

PASS_COUNT=0
FAIL_COUNT=0

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

test_case() {
    local name="$1"
    local file="$2"
    local payload="$3"
    
    log "🧪 Testing: $name"
    
    local response=$(curl -s "$BASE_URL/chat/completions" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        --data "$payload" \
        --max-time 300) # 5min timeout
    
    local http_code=$(echo "$response" | head -1 | grep -o "HTTP/[0-9.]* [0-9]*" || echo "N/A")
    
    if echo "$response" | grep -q '"error":'; then
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "$response" > "$file-error.json"
        log "❌ FAILED: $name"
        echo "   Error: $(echo "$response" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("error",{}).get("message","Unknown error"))') 2>&1"
        return 1
    elif echo "$response" | grep -q '"choices"'; then
        PASS_COUNT=$((PASS_COUNT + 1))
        echo "$response" > "$file-success.json"
        
        # Extract metrics
        local tokens=$(echo "$response" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("usage",{}).get("completion_tokens",0))' 2>/dev/null || echo "0")
        local has_reasoning=$(echo "$response" | grep -q "reasoning_content" && echo "yes" || echo "no")
        local text_length=$(echo "$response" | python3 -c 'import sys,json; d=json.load(sys.stdin); c=d.get("choices",[{}])[0].get("message",{}).get("content",""); print(len(str(c)))' 2>/dev/null || echo "0")
        
        log "✅ PASSED: $name"
        echo "   Tokens: $tokens, Reasoning: $has_reasoning, Text: ${text_length} chars"
        return 0
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        log "⚠️  UNKNOWN: $name - Malformed response"
        echo "$response" > "$file-unknown.json"
        return 1
    fi
}

log "============================================"
log "🚀 DeepSeek Browser Bridge E2E Test Suite"
log "============================================"
log ""

# Test 1: Simple Chat (Basic Q&A)
test_case "Simple Chat - Basic Greeting" \
    "$RESULTS_DIR/test01-simple-chat" \
    '{
        "model": "deepseek-v4.1-flash-think",
        "messages": [{"role": "user", "content": "Hello! Can you help me understand AI agents?"}],
        "stream": false
    }'

# Test 2: Thinking Level = max
test_case "Thinking Level=max - Deep Analysis" \
    "$RESULTS_DIR/test02-thinking-max" \
    '{
        "model": "deepseek-v4.1-flash-think",
        "messages": [{"role": "user", "content": "Please analyze deeply using max level thinking: What are the fundamental challenges in building reliable AI agents that can handle complex real-world tasks? Consider planning, tool use, error recovery, and human alignment."}],
        "stream": false,
        "thinking_level": "max"
    }'

# Test 3: Complex Task - Multi-step Analysis
test_case "Complex Task - Framework Comparison" \
    "$RESULTS_DIR/test03-complex-task" \
    '{
        "model": "deepseek-v4.1-flash-think",
        "messages": [{"role": "user", "content": "Compare three different AI agent frameworks (AutoGen, LangGraph, CrewAI) across: architecture style, strength, use cases, complexity. Create a structured comparison with pros and cons for each framework."}],
        "stream": false,
        "thinking_level": "xhigh"
    }'

# Test 4: Tool Context (Image Analysis Prompt)
test_case "Tool Context - Vision Assistant Scenario" \
    "$RESULTS_DIR/test04-tool-context" \
    '{
        "model": "deepseek-v4.1-flash-think",
        "messages": [
            {"role": "system", "content": "You are an assistant specialized in analyzing images and explaining what you see in detail."},
            {"role": "user", "content": "If you could see this image, what details would you look for? Describe your analysis approach including colors, objects, relationships, and context."}
        ],
        "stream": false
    }'

# Test 5: Web Search Context
test_case "Web Search Enabled - Current Events Query" \
    "$RESULTS_DIR/test05-web-search" \
    '{
        "model": "deepseek-v4.1-flash-think",
        "messages": [{"role": "user", "content": "If you had access to current web search, what would be the latest developments in multimodal AI? Please provide analysis based on your knowledge while acknowledging search limitations."}],
        "stream": false,
        "search": true
    }'

# Test 6: Long Reasoning Chain
test_case "Long Reasoning - Educational Explanation" \
    "$RESULTS_DIR/test06-long-reasoning" \
    '{
        "model": "deepseek-v4.1-flash-think",
        "messages": [{"role": "user", "content": "Explain neural networks comprehensively from basics to advanced: start with perceptrons, move through hidden layers, backpropagation, activation functions, gradient descent optimization, and finally how modern transformer architectures build on these foundations. Use analogies and examples throughout. Goal: someone new to ML should understand after reading."}],
        "stream": false,
        "thinking_level": "max"
    }'

# Test 7: Multi-turn Conversation Context
test_case "Multi-turn Context - Follow-up Question" \
    "$RESULTS_DIR/test07-multi-turn" \
    '{
        "model": "deepseek-v4.1-flash-think",
        "messages": [
            {"role": "user", "content": "What is machine learning and why is it important?"},
            {"role": "assistant", "content": "Machine learning is a subset of artificial intelligence that enables systems to learn patterns from data without being explicitly programmed for each task."},
            {"role": "user", "content": "Can you explain the difference between supervised learning and unsupervised learning with concrete examples?"}
        ],
        "stream": false
    }'

# Test 8: Complex Planning & Roadmap
test_case "Complex Planning - Detailed Study Guide" \
    "$RESULTS_DIR/test08-planning" \
    '{
        "model": "deepseek-v4.1-flash-think",
        "messages": [{"role": "user", "content": "Create a comprehensive Python learning roadmap from beginner to expert level. Include: distinct phases (beginner/intermediate/advanced), recommended resources (books, courses, projects), estimated timeframes per phase, specific milestones, and practical exercises. Format as detailed markdown with clear sections."}],
        "stream": false,
        "thinking_level": "high"
    }'

# Test 9: Code Generation Task
test_case "Code Generation - Working Example" \
    "$RESULTS_DIR/test09-code-gen" \
    '{
        "model": "deepseek-v4.1-flash-think",
        "messages": [{"role": "user", "content": "Write a complete, working Python script that implements a simple REST API using Flask. Include: proper error handling, at least 3 endpoints (GET, POST, DELETE), database connection setup, and usage instructions. Make sure the code is production-ready."}],
        "stream": false,
        "thinking_level": "xhigh"
    }'

# Test 10: Creative Writing
test_case "Creative Writing - Story Generation" \
    "$RESULTS_DIR/test10-creative" \
    '{
        "model": "deepseek-v4.1-flash-think",
        "messages": [{"role": "user", "content": "Write a short sci-fi story (300-500 words) about a future where humans and AI coexist. Focus on themes of cooperation, mutual understanding, and the evolution of consciousness. Make it engaging and thought-provoking."}],
        "stream": false
    }'

log ""
log "============================================"
log "📊 TEST SUMMARY"
log "============================================"
log "Total Tests: $((PASS_COUNT + FAIL_COUNT))"
log "Passed: $PASS_COUNT"
log "Failed: $FAIL_COUNT"

if [ $((PASS_COUNT + FAIL_COUNT)) -gt 0 ]; then
    PASS_RATE=$(python3 -c "print(f'{$PASS_COUNT / ($PASS_COUNT + $FAIL_COUNT) * 100:.1f}')")
    CONFIDENCE=$(python3 -c "rate=$PASS_COUNT / ($PASS_COUNT + $FAIL_COUNT) * 100; print('HIGH ✅' if rate >= 98 else 'MEDIUM ⚠️' if rate >= 90 else 'LOW ❌')" 2>/dev/null || echo "CALCULATING...")
    log "Pass Rate: $PASS_RATE%"
    log "Confidence: $CONFIDENCE"
else
    log "⚠️  No tests completed successfully"
fi

log ""
log "Report saved to: $RESULTS_DIR/"
log "============================================"

exit $FAIL_COUNT
