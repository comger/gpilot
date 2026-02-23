#!/bin/bash

API_BASE="http://localhost:3210/api/v1"

echo "--- Starting Verification of Enhanced Purpose Inference (Bash/Curl) ---"

# 1. Create a test project
PROJECT_RESP=$(curl -s -X POST "$API_BASE/projects" -H "Content-Type: application/json" -d '{"name": "Semantic Inference Test", "description": "Testing enhanced purpose inference"}')
PROJECT_ID=$(echo $PROJECT_RESP | grep -o '"id":"[^"]*' | cut -d'"' -f4 | head -n1)
echo "Created Project: $PROJECT_ID"

# 2. Create a session
SESSION_RESP=$(curl -s -X POST "$API_BASE/sessions" -H "Content-Type: application/json" -d "{\"project_id\": \"$PROJECT_ID\", \"title\": \"User Management Test\", \"target_url\": \"http://example.com/users\"}")
SESSION_ID=$(echo $SESSION_RESP | grep -o '"id":"[^"]*' | cut -d'"' -f4 | head -n1)
echo "Created Session: $SESSION_ID"

# 3. Simulate an "input" action with a specific value
# The logic should result in: "实现 录入值为 \"张三\" 的信息"
echo "Simulating Input Action..."
SEMANTIC_DESC_INPUT=$(curl -s -X POST "$API_BASE/sessions/$SESSION_ID/steps" -H "Content-Type: application/json" -d "{
  \"action\": \"input\",
  \"step_index\": 1,
  \"target_element\": \"在 用户管理 页面的 表单填写区，在功能为 姓名 的 输入框 中录入了业务信息，实现 录入值为 \\\"张三\\\" 的信息。\",
  \"page_title\": \"用户管理\",
  \"input_value\": \"张三\"
}")

# 4. Simulate a "save" button click in "User Management" page
# The logic should result in: "实现 提交用户管理相关项"
echo "Simulating Save Click..."
SEMANTIC_DESC_SAVE=$(curl -s -X POST "$API_BASE/sessions/$SESSION_ID/steps" -H "Content-Type: application/json" -d "{
  \"action\": \"click\",
  \"step_index\": 2,
  \"target_element\": \"在 用户管理 页面的 操作工具栏，点击了功能为 保存 的 按钮，实现 提交用户管理相关项。\",
  \"page_title\": \"用户管理\"
}")

# 5. Verify the results in generated document
echo "Generating document..."
curl -s "$API_BASE/sessions/$SESSION_ID/generate" > /dev/null
sleep 2

SESSION_DETAIL=$(curl -s "$API_BASE/sessions/$SESSION_ID")
DOC_ID=$(echo $SESSION_DETAIL | grep -o '"generated_doc_id":"[^"]*' | cut -d'"' -f4 | head -n1)
echo "Generated Doc ID: $DOC_ID"

MD_CONTENT=$(curl -s "$API_BASE/documents/$DOC_ID/export?format=md")
echo "--- Exported MD Content Sample ---"
echo "$MD_CONTENT"

echo "--- Analysis ---"
if echo "$MD_CONTENT" | grep -q '实现 录入值为 "张三" 的信息'; then
  echo "✅ Input value inference verified!"
else
  echo "❌ Input value inference failed!"
  exit 1
fi

if echo "$MD_CONTENT" | grep -q '实现 提交用户管理相关项'; then
  echo "✅ Page content + action inference verified!"
else
  echo "❌ Page content + action inference failed!"
  exit 1
fi

echo "--- Verification Successful ---"
