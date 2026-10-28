package com.classroom.teacher

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The session cookie at rest: AES-GCM with a key that stays inside the
 * Android Keystore, so the copy in the app's preferences is useless on its own
 * (a backup, a rooted-device file grab). If the Keystore fails (some old OEM
 * builds), the cookie is stored as before, unencrypted; values saved by older
 * versions are read as they are and sealed on the next save.
 */
object CookieVault {
    private const val ALIAS = "classroom_teacher_session"
    private const val PREFIX = "v1:"
    private const val IV_BYTES = 12

    fun seal(plain: String): String = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        PREFIX + Base64.encodeToString(sealed, Base64.NO_WRAP)
    } catch (e: Exception) {
        android.util.Log.w("ClassroomTeacher", "keystore unavailable, cookie stored unencrypted", e)
        plain
    }

    /** null when the value cannot be opened (key lost after a device reset / restore): sign in again. */
    fun open(stored: String?): String? {
        if (stored == null || !stored.startsWith(PREFIX)) return stored
        return try {
            val bytes = Base64.decode(stored.substring(PREFIX.length), Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
            String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
        } catch (e: Exception) {
            android.util.Log.w("ClassroomTeacher", "saved session could not be opened", e)
            null
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }
}
