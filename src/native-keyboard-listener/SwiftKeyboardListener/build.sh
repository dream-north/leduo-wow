#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/build"
EXECUTABLE="$OUTPUT_DIR/SwiftKeyboardListener"

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "Building SwiftKeyboardListener..."

MIN_MACOS_VERSION="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ] && [ "$ARCH" != "x86_64" ]; then
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

SWIFT_TARGET="$ARCH-apple-macos$MIN_MACOS_VERSION"
echo "Using Swift target: $SWIFT_TARGET"

# Compile the Swift source
# Explicitly set deployment target so helper can run on older supported macOS versions
swiftc \
    -target "$SWIFT_TARGET" \
    -o "$EXECUTABLE" \
    "$SCRIPT_DIR/Sources/main.swift" \
    -framework AppKit \
    -framework CoreFoundation \
    -framework CoreGraphics \
    -framework WebKit \
    -O

echo "Built successfully at: $EXECUTABLE"

# Verify the executable exists
if [ -f "$EXECUTABLE" ]; then
    echo "✓ SwiftKeyboardListener executable created"
else
    echo "✗ Failed to create executable"
    exit 1
fi
