# LOCAL ONLY. Agave 4.3.0 binaries stay in the retained tool-cache volume.
# The validator needs libstdc++; the fixed TCP bridge uses Python's standard library.
# No source tree, ledger, wallet, custody or ELF is copied into this image.
FROM debian@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 libstdc++6 ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
