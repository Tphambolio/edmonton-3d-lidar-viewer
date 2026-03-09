##############################################################################
# Blender Conversion Service — OBJ/FBX/STL/DAE/PLY/USD → GLB
#
# Wraps the existing convert_service.py + blender_convert.py in a container.
##############################################################################

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libgl1-mesa-glx \
        libxi6 \
        libxrender1 \
        libxkbcommon0 \
        python3 \
        python3-pip \
        wget \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Blender portable
RUN wget -q https://mirror.clarkson.edu/blender/release/Blender4.3/blender-4.3.2-linux-x64.tar.xz \
        -O /tmp/blender.tar.xz && \
    tar -xJf /tmp/blender.tar.xz -C /opt/ && \
    ln -s /opt/blender-4.3.2-linux-x64/blender /usr/local/bin/blender && \
    rm /tmp/blender.tar.xz

# Python deps
RUN pip3 install --no-cache-dir flask flask-cors

# App files
RUN useradd --create-home --system converter
COPY convert_service.py /home/converter/app/convert_service.py
COPY blender_convert.py /home/converter/app/blender_convert.py

RUN chown -R converter:converter /home/converter/app

USER converter
WORKDIR /home/converter/app

ENV PYTHONUNBUFFERED=1

EXPOSE 5000

CMD ["python3", "convert_service.py", "--host", "0.0.0.0", "--port", "5000"]
