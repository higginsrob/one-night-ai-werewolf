# CUDA image for NVIDIA Spark / DGX GB10 (sm_121).
# Host ships CUDA 13 (libcudart.so.13); cu12 wheels ABI-mismatch on Spark.
FROM nvidia/cuda:13.0.1-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DEVICE=cuda:0 \
    PORT=8880 \
    MODEL_ID=k2-fsa/OmniVoice \
    HF_HOME=/app/data/models \
    OMNIVOICE_DATA=/app/data \
    PATH="/opt/venv/bin:$PATH"

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-venv \
      libsndfile1 \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

WORKDIR /app

COPY pyproject.toml ./
COPY app ./app

# Use a venv so we don't fight Debian's apt-managed pip (PEP 668).
# cu130 wheels target CUDA 13 and include Blackwell / GB10 (sm_121).
RUN pip install --upgrade pip \
 && pip install \
      torch==2.11.0+cu130 torchaudio==2.11.0+cu130 \
      --extra-index-url https://download.pytorch.org/whl/cu130 \
 && pip install \
      "fastapi>=0.115.0" \
      "uvicorn[standard]>=0.32.0" \
      "python-multipart>=0.0.12" \
      "soundfile>=0.12.1" \
      "numpy>=1.26.0" \
      "omnivoice"

EXPOSE 8880

VOLUME ["/app/data"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8880"]
