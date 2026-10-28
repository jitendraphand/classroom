# Release builds are shrunk with R8 (debug builds are not).
# WebRTC is reached from native code over JNI, and LiveKit's protobuf models
# and event classes are looked up by name: keep them whole.
-keep class org.webrtc.** { *; }
-keep class io.livekit.** { *; }
-keep class livekit.** { *; }
-dontwarn org.webrtc.**
-dontwarn io.livekit.**

# Unused code is removed but names stay, so crash reports sent to
# /api/client-error read the same as from a debug build (no mapping file to keep).
-dontobfuscate
-keepattributes SourceFile,LineNumberTable
