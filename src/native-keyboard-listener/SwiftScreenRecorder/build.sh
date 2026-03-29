#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/build"
EXECUTABLE="$OUTPUT_DIR/SwiftScreenRecorder"

mkdir -p "$OUTPUT_DIR"

echo "Building SwiftScreenRecorder..."

MIN_MACOS_VERSION="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ] && [ "$ARCH" != "x86_64" ]; then
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

SWIFT_TARGET="$ARCH-apple-macos$MIN_MACOS_VERSION"
echo "Using Swift target: $SWIFT_TARGET"

swiftc \
    -target "$SWIFT_TARGET" \
    -o "$EXECUTABLE" \
    "$SCRIPT_DIR/Sources/main.swift" \
    -framework AppKit \
    -framework AVFoundation \
    -framework CoreFoundation \
    -framework CoreGraphics \
    -framework CoreMedia \
    -framework ScreenCaptureKit \
    -O

echo "Built successfully at: $EXECUTABLE"

if [ -f "$EXECUTABLE" ]; then
    echo "✓ SwiftScreenRecorder executable created"
else
    echo "✗ Failed to create executable"
    exit 1
fi
