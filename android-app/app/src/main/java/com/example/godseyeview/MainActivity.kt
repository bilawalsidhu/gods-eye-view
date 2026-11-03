package com.example.godseyeview

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.example.godseyeview.theme.GodsEyeViewTheme

class MainActivity : ComponentActivity() {
    private var webView: WebView? = null

    // The page's getUserMedia() only works once the app itself holds
    // RECORD_AUDIO, so ask for it when the page first wants the microphone.
    private var onMicResult: ((Boolean) -> Unit)? = null
    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        onMicResult?.invoke(granted)
        onMicResult = null
    }

    private fun ensureMicPermission(onResult: (Boolean) -> Unit) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            onResult(true)
            return
        }
        onMicResult = onResult
        micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Light status and navigation icons over the black bars.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView ?: return finish()
                // The page uses Back first: to leave zoom mode, or to return
                // from the on-screen controls to the globe.
                view.evaluateJavascript("window.gevHandleBack?.() === true") { used ->
                    if (used == "true") return@evaluateJavascript
                    if (view.canGoBack()) view.goBack() else finish()
                }
            }
        })
        setContent {
            GodsEyeViewTheme {
                // The page draws its own dark chrome, so keep it clear of the
                // status bar, navigation bar and camera cutout.
                Surface(modifier = Modifier.fillMaxSize(), color = Color.Black) {
                    GodsEyeWebView(
                        startUrl(),
                        Modifier.safeDrawingPadding(),
                        onCreated = { webView = it },
                        requestMic = ::ensureMicPermission,
                    )
                }
            }
        }
    }

    override fun onDestroy() {
        webView = null
        super.onDestroy()
    }
}

/**
 * The hosted server's address. With an access key, the first load passes it as
 * `?key=`; the server answers with a cookie and drops the key from the URL.
 */
private fun startUrl(): String {
    val base = Uri.parse(BuildConfig.SERVER_URL)
    if (BuildConfig.ACCESS_KEY.isEmpty()) return base.toString()
    return base.buildUpon().appendQueryParameter("key", BuildConfig.ACCESS_KEY).build().toString()
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun GodsEyeWebView(
    url: String,
    modifier: Modifier = Modifier,
    onCreated: (WebView) -> Unit,
    requestMic: ((Boolean) -> Unit) -> Unit = { it(false) },
) {
    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { context ->
            WebView(context).apply {
                // Without explicit MATCH_PARENT the WebView is WRAP_CONTENT,
                // which makes CSS viewport units (100vh, 100dvh) resolve to 0
                // and leaves the globe's canvas 0 px tall.
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                CookieManager.getInstance().setAcceptCookie(true)

                webViewClient = WebViewClient()
                webChromeClient = object : WebChromeClient() {
                    override fun onPermissionRequest(request: PermissionRequest) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE !in request.resources) {
                            request.grant(request.resources)
                            return
                        }
                        requestMic { granted ->
                            if (granted) request.grant(request.resources) else request.deny()
                        }
                    }

                    // Page console output shows in Logcat under the GEV tag.
                    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                        if (!BuildConfig.DEBUG) return false
                        Log.i("GEV", "${message.messageLevel()} ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                        return true
                    }
                }

                WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
                onCreated(this)
                loadUrl(url)
            }
        },
    )
}
