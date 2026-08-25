# imgman — the native image toolchain.
#
# This image exists for work a Worker genuinely cannot do:
#
#   * decoding HEIC (what every iPhone photo is, and what no browser reliably
#     renders) and rasterising the first page of a PDF;
#   * reading the text out of a pinned document (OCR);
#   * finding faces in a photograph, and turning each one into the 128 numbers
#     that let the same person be recognised in a different photograph.
#
# All three are C/C++ libraries with codec and model dependencies, not something
# to reimplement in WASM.
#
# Pinned by digest, not tag. `node:22-bookworm-slim` rolls forward on every Node
# patch release, so a tag would mean two builds of the same commit are not the
# same image. Bump this deliberately.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

WORKDIR /app

# imagemagick        — resampling, format conversion, metadata stripping
# libheif1/-examples — HEIC/HEIF decode + heif-convert (the iPhone photo case)
# poppler-utils      — PDF first-page rasterisation
# tesseract-ocr      — OCR, with the English language data
# fonts-dejavu-core  — not used at runtime; it is what lets `convert -annotate`
#                      render a test document inside the image so OCR can be
#                      verified without shipping a binary fixture in the repo
# python3            — runtime for detect.py only, see below
# tini               — reaps the child processes ImageMagick spawns
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini \
        ca-certificates \
        imagemagick \
        libheif1 \
        libheif-examples \
        poppler-utils \
        tesseract-ocr \
        tesseract-ocr-eng \
        fonts-dejavu-core \
        python3-minimal \
        python3-pip \
        libpython3.11-stdlib \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# OpenCV from the HEADLESS wheel, not Debian's `python3-opencv`.
#
# They are the same library, but the Debian package depends on the full GUI and
# video stack and costs about a gigabyte. The headless wheel is the same
# detector without any of that, and brings the DNN runtime the two face models
# below are loaded through.
# `--break-system-packages` is required on Debian 12 (PEP 668); this image has
# no other Python consumer to break.
RUN pip3 install --no-cache-dir --break-system-packages opencv-python-headless==4.10.0.84 \
    && find /usr/local/lib/python3* -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true

# The two face models, from OpenCV's model zoo.
#
# YUNET replaces the Haar cascade that ships with OpenCV. Haar only finds a face
# looking straight at the camera in even light, which on a board of real
# photographs means most of them are missed. More importantly it returns a box
# and nothing else, and SFace needs the five landmarks — eyes, nose, mouth
# corners — to align a crop before it can be compared to anything.
#
# SFACE turns an aligned face into 128 numbers. Two photographs of the same
# person land close together in that space and two people land far apart, which
# is what makes "who else is this?" answerable at all. It is 37 MB, and it is
# the only reason this container is worth the disk it takes.
#
# Fetched at build time and CHECKED, rather than committed. A 37 MB binary in
# git is a 37 MB binary in every clone forever, and a checksum gives the same
# guarantee — the build fails rather than silently baking in something else.
ADD --checksum=sha256:8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4 \
    https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx \
    /app/models/face_detection_yunet.onnx
ADD --checksum=sha256:0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79 \
    https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx \
    /app/models/face_recognition_sface.onnx

# ImageMagick's Debian policy blocks PDF for the ghostscript CVEs. We rasterise
# PDFs with poppler (pdftoppm) rather than delegating to ghostscript, so the
# restriction is irrelevant to us and is left in place.

COPY server.mjs detect.py ./

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
