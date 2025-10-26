#!/bin/bash
# Test script to run Nova-Code (Gemini CLI) with Ollama + Qwen

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 20

cd /models/novavoice/Nova-Code

# Configure to use Ollama via OpenAI-compatible endpoint
export LOCAL_MODEL_PROVIDER=openai-compatible
export LOCAL_MODEL_MODEL=qwen2.5-coder:7b
export LOCAL_MODEL_ENDPOINT=http://127.0.0.1:11434/v1
export OPENAI_API_KEY=ollama

echo "🚀 Starting Nova-Code with Ollama + Qwen2.5-Coder-7B"
echo "================================================"
echo "Provider: $LOCAL_MODEL_PROVIDER"
echo "Model: $LOCAL_MODEL_MODEL"
echo "Endpoint: $LOCAL_MODEL_ENDPOINT"
echo "================================================"
echo ""

# Run Nova-Code (gemini)
./bundle/gemini.js "$@"
