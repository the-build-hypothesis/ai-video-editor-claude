#!/usr/bin/env bash
# Regenerates the synthetic sample media in fixtures/ (rights-free: ffmpeg test sources).
# speech.wav must be provided (any short spoken recording; the original used Windows SAPI TTS).
set -euo pipefail
cd "$(dirname "$0")/../fixtures"
FF=../node_modules/ffmpeg-static/ffmpeg
FP=../node_modules/ffprobe-static/bin/linux/x64/ffprobe
D=$($FP -v error -show_entries format=duration -of csv=p=0 speech.wav)
$FF -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30" -i speech.wav -t "$D" -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest clip-a-speech-720p.mp4
$FF -y -loglevel error -f lavfi -i "mandelbrot=size=1920x1080:rate=30" -t 20 -c:v libx264 -preset veryfast -crf 35 -pix_fmt yuv420p clip-b-silent-1080p.mp4
$FF -y -loglevel error -f lavfi -i "smptebars=size=720x1280:rate=30" -f lavfi -i "sine=frequency=330:sample_rate=48000" -t 25 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest clip-c-portrait.mp4
$FF -y -loglevel error -f lavfi -i "sine=f=220:sample_rate=44100" -f lavfi -i "sine=f=277:sample_rate=44100" -f lavfi -i "sine=f=330:sample_rate=44100" -filter_complex "[0][1][2]amix=inputs=3,volume=2,tremolo=f=2:d=0.6,aformat=channel_layouts=stereo" -t 45 -c:a libmp3lame -b:a 160k music.mp3
$FF -y -loglevel error -f lavfi -i "color=c=0x3355ff:s=400x200,format=rgba" -frames:v 1 logo.png
head -c 200000 /dev/urandom > corrupt.mp4
echo "fixtures regenerated"
