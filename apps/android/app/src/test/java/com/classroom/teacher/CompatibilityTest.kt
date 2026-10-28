package com.classroom.teacher

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Rules that keep the app in step with the current classroom server (main). */
class CompatibilityTest {
    @Test fun privateMessagesAreMarkedAndOfferAPrivateReply() {
        val q = JSONObject("""{"scope":"TEACHER","senderRole":"STUDENT","senderName":"Asha","senderParticipantId":"p1","body":"Can I go?"}""")
        val all = JSONObject("""{"scope":"BROADCAST","senderRole":"TEACHER","senderName":"Ms Rao","body":"Page 4"}""")
        val dm = JSONObject("""{"scope":"DIRECT","senderRole":"TEACHER","senderName":"Ms Rao","recipientName":"Asha","body":"Yes"}""")
        assertEquals("Asha (private, to you): Can I go?", ChatLogic.line(q))
        assertEquals("Ms Rao: Page 4", ChatLogic.line(all))
        assertEquals("You → Asha (private): Yes", ChatLogic.line(dm))
        assertEquals("p1" to "Asha", ChatLogic.pendingPrivateQuestion(listOf(all, q)))
        assertNull(ChatLogic.pendingPrivateQuestion(listOf(q, dm)))
        assertNull(ChatLogic.pendingPrivateQuestion(emptyList()))
    }

    @Test fun plainHttpOnlyToServersOnThisNetwork() {
        assertNull(ServerAddress.problem("https://13-201-89-150.sslip.io"))
        for (ok in listOf("http://192.168.1.10:3000", "http://10.0.0.5", "http://172.20.1.1", "http://localhost:3000", "http://school.local", "http://[fd12::1]:3000")) {
            assertNull(ok, ServerAddress.problem(ok))
        }
        for (bad in listOf("http://13.201.89.150", "http://classes.example.org", "http://172.32.0.1", "ftp://x", "https://user:pw@x.org", "nonsense")) {
            assertNotNull(bad, ServerAddress.problem(bad))
        }
        assertTrue(ServerAddress.problem("http://example.org")!!.contains("https://"))
    }

    @Test fun mediaFollowsTheServerProfile() {
        assertEquals(Media.Profile.LOW, Media.parseProfile("low"))
        assertEquals(Media.Profile.STANDARD, Media.parseProfile(null))
        val cam = Media.camera(Media.Profile.STANDARD)
        assertEquals(listOf(640, 360, 15, 300_000), listOf(cam.width, cam.height, cam.fps, cam.maxBitrate))
        assertEquals(90_000, cam.layers.single().maxBitrate)
        val low = Media.camera(Media.Profile.LOW)
        assertEquals(120_000, low.maxBitrate)
        assertTrue(low.layers.isEmpty())
        assertEquals(1_000_000, Media.share(Media.Profile.LOW).maxBitrate)
        assertEquals(10, Media.share(Media.Profile.LOW).fps)
    }
}
