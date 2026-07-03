FROM python:3.14-slim

# System deps occasionally needed by numpy/scipy/torch wheels at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # Bake the HuggingFace model into the image (see download step below) so
    # cold starts don't pull ~1 GB over the network on every new instance.
    HF_HOME=/opt/hf

WORKDIR /app

# Install Python deps first so this layer is cached across code changes.
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

# Pre-download the sentence-transformer model into the image's HF cache.
RUN python -c "from sentence_transformers import SentenceTransformer; \
    SentenceTransformer('microsoft/harrier-oss-v1-0.6b')"

# Copy the application code.
COPY . .

# Cloud Run sends traffic to $PORT (default 8080) and expects 0.0.0.0.
# flask-sock works under gunicorn with the threaded worker; --timeout 0
# stops gunicorn from killing long-lived WebSocket (Gemini Live) connections.
ENV PORT=8080
CMD exec gunicorn \
    --worker-class gthread \
    --workers 1 \
    --threads 16 \
    --timeout 0 \
    --bind 0.0.0.0:$PORT \
    app:app
