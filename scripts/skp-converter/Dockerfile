##############################################################################
# SKP → GLB Conversion Service
#
# Ubuntu 22.04 + Wine + Xvfb + SketchUp 8 (via winetricks) + Blender 4.3
# Accepts .skp uploads via FastAPI, converts SKP → DAE (SketchUp Ruby)
# then DAE → GLB (Blender headless), returns GLB.
#
# Based on: github.com/lcorbasson/docker-skp2dae
##############################################################################

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV WINEDEBUG=-all

# ── System packages ──────────────────────────────────────────────────────────

RUN dpkg --add-architecture i386 && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        cabextract \
        curl \
        libgl1-mesa-glx \
        libgl1-mesa-glx:i386 \
        libgnutls30 \
        libgnutls30:i386 \
        libxml2 \
        libxml2:i386 \
        procps \
        python3 \
        python3-pip \
        timelimit \
        wget \
        winbind \
        xauth \
        xdotool \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

# ── Wine (stable from WineHQ) ───────────────────────────────────────────────

RUN mkdir -pm755 /etc/apt/keyrings && \
    wget -O /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key && \
    wget -NP /etc/apt/sources.list.d/ https://dl.winehq.org/wine-builds/ubuntu/dists/jammy/winehq-jammy.sources && \
    apt-get update && \
    apt-get install -y --install-recommends winehq-stable && \
    rm -rf /var/lib/apt/lists/*

# ── Winetricks (latest from GitHub) ─────────────────────────────────────────

RUN wget https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks \
        -O /usr/local/bin/winetricks && \
    chmod +x /usr/local/bin/winetricks

# ── Wait helper (wait for wineserver to finish) ─────────────────────────────

COPY scripts/waitfor.sh /usr/local/bin/waitfor
RUN chmod +x /usr/local/bin/waitfor

# ── Create unprivileged user ────────────────────────────────────────────────

RUN groupadd --system sketchup && \
    useradd --create-home --system --gid sketchup sketchup

USER sketchup
ENV HOME=/home/sketchup
ENV WINEPREFIX=/home/sketchup/.wine
ENV WINEARCH=win32
WORKDIR /home/sketchup

# ── Initialize Wine prefix ──────────────────────────────────────────────────

RUN rm -rf /home/sketchup/.wine && \
    wine wineboot --init && \
    waitfor sketchup wineserver && \
    wine --version

# ── Wine dependencies for SketchUp 8 ────────────────────────────────────────

RUN xvfb-run -a winetricks --unattended corefonts && waitfor sketchup wineserver
RUN xvfb-run -a winetricks --unattended msxml3    && waitfor sketchup wineserver
RUN xvfb-run -a winetricks --unattended vcrun2005 && waitfor sketchup wineserver
RUN xvfb-run -a winetricks --unattended vcrun2010 && waitfor sketchup wineserver

# ── Wine display settings ───────────────────────────────────────────────────

COPY wine-config/Wine-NotDecoratedByWindowManager.reg /home/sketchup/
RUN wine regedit Wine-NotDecoratedByWindowManager.reg && waitfor sketchup wineserver

# ── Install SketchUp 8 via winetricks ───────────────────────────────────────

RUN xvfb-run -a winetricks --unattended sketchup && waitfor sketchup wineserver

# ── SketchUp 8 registry tweaks (skip dialogs, enable HW accel flag) ─────────

COPY wine-config/SketchUp8-HW_OK.reg /home/sketchup/
COPY wine-config/SketchUp8-Preferences.reg /home/sketchup/
RUN wine regedit SketchUp8-HW_OK.reg && waitfor sketchup wineserver
RUN wine regedit SketchUp8-Preferences.reg && waitfor sketchup wineserver

# ── Blender (portable, for DAE → GLB conversion) ────────────────────────────

USER root
RUN wget -q https://mirror.clarkson.edu/blender/release/Blender4.3/blender-4.3.2-linux-x64.tar.xz \
        -O /tmp/blender.tar.xz && \
    tar -xJf /tmp/blender.tar.xz -C /opt/ && \
    ln -s /opt/blender-4.3.2-linux-x64/blender /usr/local/bin/blender && \
    rm /tmp/blender.tar.xz

# ── Python dependencies ─────────────────────────────────────────────────────

COPY requirements.txt /home/sketchup/app/requirements.txt
RUN pip3 install --no-cache-dir -r /home/sketchup/app/requirements.txt

# ── Application files ───────────────────────────────────────────────────────

COPY server.py /home/sketchup/app/server.py
COPY scripts/skp_export.tmpl.rb /home/sketchup/app/skp_export.tmpl.rb
COPY scripts/blender_dae_to_glb.py /home/sketchup/app/blender_dae_to_glb.py

RUN chown -R sketchup:sketchup /home/sketchup/app

USER sketchup
WORKDIR /home/sketchup/app

EXPOSE 5001

CMD ["python3", "server.py"]
