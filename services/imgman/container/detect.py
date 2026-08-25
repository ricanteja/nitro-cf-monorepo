# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

"""Find faces in an image, and describe each one, as JSON.

Called by server.mjs rather than imported. It is the one job in this container
that Node has no reasonable library for, so it gets a Python process and
nothing else does.

Two models, doing two different things:

  YuNet    finds faces and returns five landmarks for each — eye centres, nose
           tip, mouth corners.
  SFace    turns ONE aligned face into 128 numbers, close together for two
           photographs of the same person and far apart for two people.

The landmarks are the join between them: SFace compares faces only if they have
first been rotated and scaled to a canonical position, and the landmarks are
what makes that possible. A bounding box on its own is not enough, which is why
the Haar cascade this replaced could find faces but never tell you whose.

Coordinates come back in the ORIGINAL image's pixel space even though detection
runs on a downscaled copy, because the caller stores them against the full-size
image and cannot know what scale was used. The embedding, by contrast, is taken
from the FULL-RESOLUTION crop: downscaling costs recognition accuracy in a way
it does not cost detection.
"""

import json
import os
import sys

import cv2
import numpy as np

MODEL_DIR = os.environ.get("FACE_MODEL_DIR", "/app/models")
DETECTOR = os.path.join(MODEL_DIR, "face_detection_yunet.onnx")
RECOGNISER = os.path.join(MODEL_DIR, "face_recognition_sface.onnx")

# Detection accuracy is unaffected at this size and it is several times faster,
# which matters on a quarter-vCPU container instance.
DETECT_MAX_EDGE = 640

# YuNet scores every candidate; below this it is guessing. 0.7 is stricter than
# the model's 0.6 default, because every detection becomes a box somebody has to
# dismiss by hand, and a missed face costs less than a wrong one.
SCORE_THRESHOLD = 0.7
NMS_THRESHOLD = 0.3
TOP_K = 500

# Smaller than this in the original image and there is not enough detail left
# for the embedding to mean anything, however confident the detector is.
MIN_FACE_PX = 40


def main(path: str) -> int:
    image = cv2.imread(path)
    if image is None:
        print(json.dumps({"error": "unreadable image", "faces": []}))
        return 0

    height, width = image.shape[:2]
    longest = max(height, width)
    scale = DETECT_MAX_EDGE / longest if longest > DETECT_MAX_EDGE else 1.0
    small = cv2.resize(image, None, fx=scale, fy=scale) if scale < 1.0 else image

    detector = cv2.FaceDetectorYN.create(
        DETECTOR, "", (320, 320), SCORE_THRESHOLD, NMS_THRESHOLD, TOP_K
    )
    detector.setInputSize((small.shape[1], small.shape[0]))
    _, found = detector.detect(small)
    if found is None:
        print(json.dumps({"width": width, "height": height, "faces": []}))
        return 0

    recogniser = cv2.FaceRecognizerSF.create(RECOGNISER, "")

    faces = []
    for row in found:
        x, y, w, h = (int(v / scale) for v in row[:4])
        if w < MIN_FACE_PX or h < MIN_FACE_PX:
            continue

        # The detection row is in the DOWNSCALED image's coordinates and
        # alignCrop needs it to match the image it is given, so the whole row —
        # box and landmarks alike — is scaled back up before being handed the
        # full-resolution frame.
        full = row.copy()
        full[:14] = full[:14] / scale
        try:
            embedding = recogniser.feature(recogniser.alignCrop(image, full))
        except cv2.error:
            # A face at the very edge can produce a crop the aligner refuses.
            # Losing its identity is survivable; losing the detection is not.
            embedding = None

        faces.append(
            {
                "x": x,
                "y": y,
                "w": w,
                "h": h,
                "score": round(float(row[-1]), 4),
                "embedding": (
                    [round(float(v), 6) for v in np.asarray(embedding).ravel()]
                    if embedding is not None
                    else None
                ),
            }
        )

    # Largest first: the subject of a photograph is usually the biggest face in
    # it, and the board shows them in this order.
    faces.sort(key=lambda f: f["w"] * f["h"], reverse=True)

    print(json.dumps({"width": width, "height": height, "faces": faces}))
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: detect.py <image>", "faces": []}))
        sys.exit(0)
    sys.exit(main(sys.argv[1]))
