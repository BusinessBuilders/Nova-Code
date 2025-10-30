#!/bin/bash
# Test script to run Nova-Code (Gemini CLI) with llama.cpp + Qwen

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 20

cd /mnt/ssd/models/novavoice/Nova-Code

# Configure to use llama.cpp via OpenAI-compatible endpoint
export LOCAL_MODEL_PROVIDER=openai-compatible
export LOCAL_MODEL_MODEL=/models/qwen3-coder-30b/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf
export LOCAL_MODEL_ENDPOINT=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=dummy

echo "🚀 Starting Nova-Code with llama.cpp + Qwen3-Coder-30B"
echo "================================================"
echo "Provider: $LOCAL_MODEL_PROVIDER"
echo "Model: $LOCAL_MODEL_MODEL"
echo "Endpoint: $LOCAL_MODEL_ENDPOINT"
echo "================================================"
echo ""

# Run Nova-Code (gemini) - removed debug to reduce context size
./bundle/gemini.js "$@"
