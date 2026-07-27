package com.lggram.agentwebui;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST_CODE = 7201;
    private static final String STATE_WEB_VIEW = "agent_web_view";

    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout errorView;
    private TextView errorDetails;
    private ValueCallback<Uri[]> fileChooserCallback;
    private NativeNotificationBridge notificationBridge;
    private String notificationShim;
    private String pendingNotificationTag;
    private boolean pageReady;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureSystemBars();
        setContentView(createContentView());
        configureWebView();
        captureNotificationIntent(getIntent());

        Bundle webState = savedInstanceState == null
                ? null
                : savedInstanceState.getBundle(STATE_WEB_VIEW);
        if (webState == null || webView.restoreState(webState) == null) {
            webView.loadUrl(BuildConfig.WEB_APP_URL);
        }
    }

    @SuppressLint({ "SetJavaScriptEnabled", "AddJavascriptInterface" })
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setUserAgentString(
                settings.getUserAgentString() + " AgentWebUIAndroid/" + BuildConfig.VERSION_NAME
        );
        settings.setSafeBrowsingEnabled(true);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, false);

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        notificationBridge = new NativeNotificationBridge(this, webView);
        webView.addJavascriptInterface(notificationBridge, "AgentAndroid");
        webView.setWebViewClient(new AgentWebViewClient());
        webView.setWebChromeClient(new AgentWebChromeClient());
        webView.setDownloadListener(new AgentDownloadListener());
    }

    private View createContentView() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(24, 24, 27));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(3)
        );
        progressParams.gravity = Gravity.TOP;
        root.addView(progressBar, progressParams);

        errorView = new LinearLayout(this);
        errorView.setOrientation(LinearLayout.VERTICAL);
        errorView.setGravity(Gravity.CENTER);
        errorView.setPadding(dp(32), dp(32), dp(32), dp(32));
        errorView.setBackgroundColor(Color.WHITE);
        errorView.setVisibility(View.GONE);

        TextView title = new TextView(this);
        title.setText(R.string.connection_error_title);
        title.setTextColor(Color.rgb(25, 25, 25));
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        errorView.addView(title, wrapContentWithBottomMargin(dp(12)));

        errorDetails = new TextView(this);
        errorDetails.setText(R.string.connection_error_default);
        errorDetails.setTextColor(Color.rgb(95, 95, 95));
        errorDetails.setTextSize(15);
        errorDetails.setGravity(Gravity.CENTER);
        errorDetails.setLineSpacing(0, 1.2f);
        errorView.addView(errorDetails, wrapContentWithBottomMargin(dp(24)));

        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setTextColor(Color.WHITE);
        retry.setAllCaps(false);
        retry.setBackground(roundedBackground(Color.rgb(7, 193, 96), dp(8)));
        retry.setOnClickListener(view -> {
            hideConnectionError();
            webView.reload();
        });
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(dp(220), dp(48));
        buttonParams.bottomMargin = dp(10);
        errorView.addView(retry, buttonParams);

        Button openTailscale = new Button(this);
        openTailscale.setText(R.string.open_tailscale);
        openTailscale.setTextColor(Color.rgb(55, 55, 55));
        openTailscale.setAllCaps(false);
        openTailscale.setBackground(roundedBackground(Color.rgb(238, 238, 238), dp(8)));
        openTailscale.setOnClickListener(view -> openTailscale());
        errorView.addView(openTailscale, new LinearLayout.LayoutParams(dp(220), dp(48)));

        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        return root;
    }

    private final class AgentWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleNavigation(request.getUrl().toString());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNavigation(url);
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            pageReady = false;
            progressBar.setVisibility(View.VISIBLE);
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            if (NavigationPolicy.isTrustedAppUrl(url)) {
                hideConnectionError();
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            progressBar.setVisibility(View.GONE);
            if (!NavigationPolicy.isTrustedAppUrl(url)) return;
            pageReady = true;
            injectNativeNotificationShim();
            dispatchPendingNotificationClick();
        }

        @Override
        public void onReceivedError(
                WebView view,
                WebResourceRequest request,
                WebResourceError error
        ) {
            if (!request.isForMainFrame()) return;
            showConnectionError(getString(
                    R.string.connection_error_with_code,
                    error.getErrorCode()
            ));
        }

        @Override
        public void onReceivedHttpError(
                WebView view,
                WebResourceRequest request,
                WebResourceResponse errorResponse
        ) {
            if (request.isForMainFrame() && errorResponse.getStatusCode() >= 500) {
                showConnectionError(getString(
                        R.string.connection_error_http,
                        errorResponse.getStatusCode()
                ));
            }
        }

        @Override
        public void onReceivedSslError(
                WebView view,
                SslErrorHandler handler,
                SslError error
        ) {
            handler.cancel();
            showConnectionError(getString(R.string.connection_error_tls));
        }

    }

    private final class AgentWebChromeClient extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progressBar.setProgress(newProgress);
            progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public boolean onShowFileChooser(
                WebView view,
                ValueCallback<Uri[]> callback,
                FileChooserParams fileChooserParams
        ) {
            if (fileChooserCallback != null) {
                fileChooserCallback.onReceiveValue(null);
            }
            fileChooserCallback = callback;

            Intent picker;
            try {
                picker = fileChooserParams.createIntent();
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                startActivityForResult(
                        Intent.createChooser(picker, getString(R.string.choose_file)),
                        FILE_CHOOSER_REQUEST_CODE
                );
                return true;
            } catch (ActivityNotFoundException error) {
                fileChooserCallback = null;
                Toast.makeText(
                        MainActivity.this,
                        R.string.no_file_picker,
                        Toast.LENGTH_SHORT
                ).show();
                return false;
            }
        }
    }

    private final class AgentDownloadListener implements DownloadListener {
        @Override
        public void onDownloadStart(
                String url,
                String userAgent,
                String contentDisposition,
                String mimeType,
                long contentLength
        ) {
            if (!NavigationPolicy.isTrustedAppUrl(url)) {
                Toast.makeText(MainActivity.this, R.string.download_blocked, Toast.LENGTH_SHORT)
                        .show();
                return;
            }

            try {
                String filename = URLUtil.guessFileName(url, contentDisposition, mimeType)
                        .replaceAll("[\\\\/:*?\"<>|]", "_");
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType(mimeType);
                request.addRequestHeader("User-Agent", userAgent);
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null && !cookies.isBlank()) {
                    request.addRequestHeader("Cookie", cookies);
                }
                request.setTitle(filename);
                request.setDescription(getString(R.string.downloading));
                request.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                );
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
                } else {
                    request.setDestinationInExternalFilesDir(
                            MainActivity.this,
                            Environment.DIRECTORY_DOWNLOADS,
                            filename
                    );
                }
                DownloadManager manager =
                        (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                manager.enqueue(request);
                Toast.makeText(
                        MainActivity.this,
                        getString(R.string.download_started, filename),
                        Toast.LENGTH_LONG
                ).show();
            } catch (RuntimeException error) {
                Toast.makeText(MainActivity.this, R.string.download_failed, Toast.LENGTH_LONG)
                        .show();
            }
        }
    }

    private boolean handleNavigation(String url) {
        if (NavigationPolicy.isTrustedAppUrl(url)) return false;
        if ("about:blank".equals(url) || (url != null && url.startsWith("blob:"))) return false;
        if (!NavigationPolicy.canOpenExternally(url)) {
            Toast.makeText(this, R.string.link_blocked, Toast.LENGTH_SHORT).show();
            return true;
        }

        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, R.string.no_link_handler, Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void injectNativeNotificationShim() {
        if (notificationShim == null) {
            try {
                notificationShim = readAsset("native-notifications.js");
            } catch (IOException error) {
                return;
            }
        }
        webView.evaluateJavascript(notificationShim, null);
    }

    private String readAsset(String name) throws IOException {
        StringBuilder script = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                getAssets().open(name),
                StandardCharsets.UTF_8
        ))) {
            String line;
            while ((line = reader.readLine()) != null) {
                script.append(line).append('\n');
            }
        }
        return script.toString();
    }

    private void captureNotificationIntent(Intent intent) {
        if (intent == null) return;
        String tag = intent.getStringExtra(NativeNotificationBridge.EXTRA_NOTIFICATION_TAG);
        if (tag == null || tag.isBlank()) return;
        pendingNotificationTag = tag;
        intent.removeExtra(NativeNotificationBridge.EXTRA_NOTIFICATION_TAG);
        dispatchPendingNotificationClick();
    }

    private void dispatchPendingNotificationClick() {
        if (!pageReady || pendingNotificationTag == null) return;
        String tag = pendingNotificationTag;
        pendingNotificationTag = null;
        String script = "window.__agentNativeOpenNotification&&"
                + "window.__agentNativeOpenNotification(" + JSONObject.quote(tag) + ");";
        webView.evaluateJavascript(script, null);
    }

    private void openTailscale() {
        Intent launch = getPackageManager().getLaunchIntentForPackage("com.tailscale.ipn");
        if (launch != null) {
            startActivity(launch);
            return;
        }
        try {
            startActivity(new Intent(
                    Settings.ACTION_WIRELESS_SETTINGS
            ));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, R.string.tailscale_not_found, Toast.LENGTH_SHORT).show();
        }
    }

    private void showConnectionError(String details) {
        progressBar.setVisibility(View.GONE);
        errorDetails.setText(details);
        errorView.setVisibility(View.VISIBLE);
        errorView.bringToFront();
    }

    private void hideConnectionError() {
        errorView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
    }

    private void configureSystemBars() {
        Window window = getWindow();
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.setNavigationBarDividerColor(Color.TRANSPARENT);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
        }
        applySystemBarAppearance(false, false);
    }

    void applySystemBarAppearance(
            boolean lightStatusBar,
            boolean lightNavigationBar
    ) {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller == null) return;
            int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            int appearance = 0;
            if (lightStatusBar) {
                appearance |= WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;
            }
            if (lightNavigationBar) {
                appearance |= WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            }
            controller.setSystemBarsAppearance(appearance, mask);
            return;
        }

        int visibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        if (lightStatusBar) visibility |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (lightNavigationBar) visibility |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        window.getDecorView().setSystemUiVisibility(visibility);
    }

    private LinearLayout.LayoutParams wrapContentWithBottomMargin(int bottomMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.bottomMargin = bottomMargin;
        return params;
    }

    private GradientDrawable roundedBackground(int color, int radius) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(radius);
        return background;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureNotificationIntent(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST_CODE || fileChooserCallback == null) return;
        Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        fileChooserCallback.onReceiveValue(result);
        fileChooserCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            String[] permissions,
            int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        notificationBridge.onRequestPermissionsResult(requestCode);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        Bundle webState = new Bundle();
        webView.saveState(webState);
        outState.putBundle(STATE_WEB_VIEW, webState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
        if (webView != null) {
            webView.removeJavascriptInterface("AgentAndroid");
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
        }
        super.onDestroy();
    }
}
