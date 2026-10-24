import java.util.Properties
import java.text.SimpleDateFormat
import java.util.Date

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Every build gets a fresh version: code = 100 + commit count, name = 1.1.0-<date>.
val gitCommits: Int = try {
    val p = ProcessBuilder("git", "rev-list", "--count", "HEAD").directory(rootDir).redirectErrorStream(true).start()
    p.inputStream.bufferedReader().readText().trim().toInt().also { p.waitFor() }
} catch (_: Exception) {
    0
}
val buildDate: String = SimpleDateFormat("yyyyMMdd").format(Date())

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
        versionName = "1.1.0-$buildDate"
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
            isMinifyEnabled = false
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
