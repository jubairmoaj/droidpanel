// droidpanel network logger for OkHttp (native Android / Retrofit) — https://github.com/jubairmoaj/droidpanel
//
// Logs every request/response to logcat (tag DPNET) for the droidpanel "Network" tab.
// Debug builds only:
//
//   val client = OkHttpClient.Builder()
//       .apply { if (BuildConfig.DEBUG) addNetworkInterceptor(DroidpanelNet()) }
//       .build()
package droidpanel

import android.util.Log
import okhttp3.Interceptor
import okhttp3.Response
import okio.Buffer
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

class DroidpanelNet(private val maxBodyChars: Long = 64 * 1024) : Interceptor {
    private val masked = setOf("authorization", "cookie", "set-cookie")

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val started = System.currentTimeMillis()
        val id = "$started-${seq.getAndIncrement()}"
        val reqBody = req.body?.let { body ->
            if (body.isOneShot() || body.isDuplex()) "<streaming body>"
            else Buffer().also { body.writeTo(it) }.let { it.readUtf8(minOf(it.size, maxBodyChars)) }
        }
        emit(id, "start", JSONObject()
            .put("method", req.method).put("url", req.url.toString()).put("startedAt", started)
            .put("reqHeaders", headers(req.headers.toMultimap())).put("reqBody", reqBody))

        val res = try {
            chain.proceed(req)
        } catch (e: Exception) {
            emit(id, "end", JSONObject().put("durationMs", System.currentTimeMillis() - started)
                .put("error", "${e.javaClass.simpleName}: ${e.message}"))
            throw e
        }
        val body = try { res.peekBody(maxBodyChars).string() } catch (e: Exception) { null }
        emit(id, "end", JSONObject()
            .put("status", res.code).put("durationMs", System.currentTimeMillis() - started)
            .put("resHeaders", headers(res.headers.toMultimap())).put("resBody", body))
        return res
    }

    private fun headers(h: Map<String, List<String>>) = JSONObject().also { o ->
        h.forEach { (k, v) ->
            val value = v.joinToString(", ")
            o.put(k, if (k.lowercase() in masked && value.length > 10) "…" + value.takeLast(6) else value)
        }
    }

    private fun emit(id: String, phase: String, event: JSONObject) {
        val json = event.put("id", id).put("phase", phase).toString()
        val chunk = 800
        val n = (json.length + chunk - 1) / chunk
        for (i in 0 until n) {
            Log.i("DPNET", "DPNET|$id.$phase|$i|$n|" + json.substring(i * chunk, minOf(json.length, (i + 1) * chunk)))
        }
    }

    companion object { private val seq = AtomicLong() }
}
