import java.util.Properties
import java.text.SimpleDateFormat
import java.util.Date

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Every build gets a fresh version: code = 100 + commit count, name = 1.2.0-<date>.
// (CI checks out the full history so the count matches a local build.)
val gitCommits: Int = try {
    val p = ProcessBuilder("git", "rev-list", "--count", "HEAD").directory(rootDir).redirectErrorStream(true).start()
    p.inputStream.bufferedReader().readText().trim().toInt().also { p.waitFor() }
} catch (_: Exception) {
    0
}
val buildDate: String = SimpleDateFormat("yyyyMMdd").format(Date())

// Pre-filled server address on the sign-in screen. A school build sets
// CLASSROOM_DEFAULT_SERVER (same variable as the Windows app).
val defaultServer: String = (System.getenv("CLASSROOM_DEFAULT_SERVER")?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
    ?: "https://13-201-89-150.sslip.io").also {
    require(Regex("^https?://[A-Za-z0-9.:\\[\\]_-]+(/[A-Za-z0-9._~/-]*)?$").matches(it)) { "CLASSROOM_DEFAULT_SERVER is not a server address: $it" }
}

// Release signing: a properties file outside the repo (storeFile / storePassword /
// keyAlias / keyPassword), path in CLASSROOM_SIGNING. Without it, release is unsigned.
val signingProps: Properties? = System.getenv("CLASSROOM_SIGNING")?.let { path ->
    val f = file(path)
    if (f.exists()) Properties().also { pr -> f.inputStream().use { pr.load(it) } } else null
}

android {
    namespace = "com.classroom.teacher"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.classroom.teacher"
        minSdk = 26
        targetSdk = 35
        versionCode = 100 + gitCommits
        versionName = "1.2.0-$buildDate"
        buildConfigField("String", "DEFAULT_SERVER", "\"$defaultServer\"")
    }

    signingConfigs {
        if (signingProps != null) {
            create("release") {
                storeFile = file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            if (signingProps != null) signingConfig = signingConfigs.getByName("release")
            // Phones and tablets are ARM: leaving out the x86 WebRTC libraries
            // and shrinking the code roughly halves the download. Debug builds
            // keep every ABI (emulators) and are not shrunk.
            ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.livekit:livekit-android:2.29.0")
}
