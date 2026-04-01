#!/bin/bash
# Download all-MiniLM-L6-v2 ONNX model for local embeddings
# Small (22MB) sentence-transformer model with 384-dim embeddings

set -e

MODEL_DIR="$(cd "$(dirname "$0")/.." && pwd)/.memory-domain/model"
mkdir -p "$MODEL_DIR"

HF_BASE="https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main"

echo "Downloading model to $MODEL_DIR ..."

if [ ! -f "$MODEL_DIR/model.onnx" ]; then
  echo "  Downloading model.onnx ..."
  curl -fSL "$HF_BASE/onnx/model.onnx" -o "$MODEL_DIR/model.onnx"
else
  echo "  model.onnx already exists, skipping"
fi

if [ ! -f "$MODEL_DIR/vocab.txt" ]; then
  echo "  Downloading vocab.txt ..."
  curl -fSL "$HF_BASE/vocab.txt" -o "$MODEL_DIR/vocab.txt"
else
  echo "  vocab.txt already exists, skipping"
fi

echo "Done. Model files:"
ls -lh "$MODEL_DIR/"
