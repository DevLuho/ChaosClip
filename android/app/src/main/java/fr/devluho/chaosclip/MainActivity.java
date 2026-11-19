package fr.devluho.chaosclip;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.system.Os;
import android.text.TextUtils;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

// Coque Android : démarre le serveur ChaosClip (Node embarqué) puis affiche son interface dans une WebView.
public class MainActivity extends Activity {
    static {
        System.loadLibrary("node");
        System.loadLibrary("nodebridge");
    }

    private static final String ORIGIN = "http://127.0.0.1:4870";
    // Node ne peut être lancé qu'une fois par processus : l'état survit à la recréation de l'activité.
    private static boolean started;
    // Les autres applis du téléphone peuvent joindre 127.0.0.1 : le serveur exige ce secret, tiré à chaque lancement.
    private static final String TOKEN = new BigInteger(128, new SecureRandom()).toString(16);

    // shortcut: couleur du thème sombre par défaut (--bg de style.css) ; à relier au thème choisi si le clair jure.
    private static final int BACKGROUND = 0xFF191B1A;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private volatile String shared; // lien ou vidéo reçus d'une autre appli, lus par la page depuis un autre fil
    private final Handler handler = new Handler(Looper.getMainLooper());

    private static final String CHAOSTOOLS = "https://chaos-tools-rp.fly.dev";
    // Rend le jeton que le site garde dans son stockage une fois connecté, s'il n'est pas périmé (comme electron/main.js).
    private static final String TOKEN_SCRIPT = "(function(){try{if(location.origin!=='" + CHAOSTOOLS + "')return null;"
            + "var t=localStorage.getItem('chaos_token');"
            + "var p=JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));"
            + "return p.exp*1000>Date.now()+60000?t:null}catch(e){return null}})()";
    private WebView login; // page de Chaos Tools, posée par-dessus l'appli le temps de s'y connecter
    private int percent = -1; // avancement affiché par la notification de WorkService, -1 quand rien ne tourne
    private boolean visible;

    private native int startNode(String[] args);

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Build de test : la page s'inspecte depuis chrome://inspect sur le PC.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        // Android 15+ dessine sous la barre d'état et le clavier : on réserve leur place autour de la page
        // (une WebView ignore son propre padding, d'où le conteneur).
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);
        root.addView(web);
        root.setOnApplyWindowInsetsListener((v, i) -> {
            v.setPadding(i.getSystemWindowInsetLeft(), i.getSystemWindowInsetTop(), i.getSystemWindowInsetRight(), i.getSystemWindowInsetBottom());
            return i;
        });
        setContentView(root);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setTextZoom(Math.round(100 * getResources().getConfiguration().fontScale)); // la taille de police réglée dans Android
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (r.getUrl().toString().startsWith(ORIGIN)) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl())); // liens externes : navigateur
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    startActivityForResult(p.createIntent(), 1);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "ChaosClipAndroid");
        // En attendant le serveur : au premier lancement, le déballage des outils peut prendre une minute.
        boolean first = !new File(getFilesDir(), "nodejs-project").isDirectory();
        web.loadDataWithBaseURL(null, "<body style='margin:0;height:100vh;display:grid;place-items:center;text-align:center;"
                + "background:#191b1a;color:#c4c8be;font:16px sans-serif'><div><b style='font-size:24px;color:#f2eee4'>ChaosClip</b><p>"
                + (first ? "Premier lancement : préparation des outils, jusqu’à une minute…" : "Démarrage…")
                + "</p></div></body>", "text/html", "utf-8", null);
        receive(getIntent());
        new Thread(this::boot).start();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        receive(intent);
    }

    // « Partager » ou « Ouvrir avec » vers ChaosClip : on garde le lien du texte reçu ou le chemin du fichier reçu
    // (vidéo, image), la page vient le chercher (takeShared).
    private void receive(Intent intent) {
        boolean view = Intent.ACTION_VIEW.equals(intent.getAction());
        if (!view && !Intent.ACTION_SEND.equals(intent.getAction())) return;
        Uri video = view ? intent.getData() : intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (video != null) {
            if (!"content".equals(video.getScheme())) return; // un « file:// » pourrait viser les fichiers de l'appli elle-même
            // shortcut: messages en français seulement, la langue de l'interface n'est connue que de la page ; à traduire si l'anglais compte ici.
            Toast.makeText(this, "Ouverture du fichier…", Toast.LENGTH_SHORT).show();
            new Thread(() -> receiveVideo(video)).start();
            return;
        }
        Matcher url = Pattern.compile("https?://\\S+").matcher(String.valueOf(intent.getStringExtra(Intent.EXTRA_TEXT)));
        if (url.find()) announce(url.group());
    }

    // Le serveur veut un vrai fichier : la vidéo est copiée dans son dossier de travail,
    // que lib/cleanup.js vide tout seul au bout d'une semaine.
    private void receiveVideo(Uri video) {
        File dir = new File(getFilesDir(), "chaosclip/work/partage-" + System.currentTimeMillis());
        try {
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(getContentResolver().getType(video));
            String name = "partage." + (ext != null ? ext : "mp4"); // si l'autre appli ne donne pas de nom
            try (Cursor c = getContentResolver().query(video, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst() && c.getString(0) != null) name = new File(c.getString(0)).getName(); // getName : pas de « ../ »
            }
            File out = new File(dir, name);
            dir.mkdirs();
            try (InputStream in = getContentResolver().openInputStream(video); OutputStream os = new FileOutputStream(out)) {
                copy(in, os);
            }
            runOnUiThread(() -> announce(out.getPath()));
        } catch (Exception e) {
            android.util.Log.w("ChaosClip", "Vidéo partagée illisible", e);
            delete(dir);
            runOnUiThread(() -> Toast.makeText(this, "ChaosClip n’a pas pu lire ce fichier", Toast.LENGTH_LONG).show());
        }
    }

    private void announce(String value) {
        shared = value;
        web.evaluateJavascript("window.dispatchEvent(new Event('chaosclip-share'))", null); // sans effet tant que la page n'est pas chargée
    }

    // Ce que la page peut demander à l'appli (window.ChaosClipAndroid, voir public/js/util.js).
    private class Bridge {
        @JavascriptInterface
        public String takeShared() {
            String url = shared;
            shared = null;
            return url != null ? url : "";
        }

        // Ouvre la feuille de partage sur un export. FileProvider refuse tout fichier hors des dossiers d'exports.
        @JavascriptInterface
        public void share(String path) {
            Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", new File(path));
            String type = mime(path);
            Intent send = new Intent(Intent.ACTION_SEND)
                    .setType(type != null ? type : "*/*")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            send.setClipData(ClipData.newRawUri(null, uri)); // sans lui, la feuille de partage n'a pas le droit de lire l'aperçu
            startActivity(Intent.createChooser(send, null));
        }

        // Copie un export dans la galerie (image, vidéo) ou, à défaut, dans Téléchargements.
        // Rend le dossier d'arrivée, ou "" si la copie n'a pas pu se faire.
        @JavascriptInterface
        public String save(String path) {
            // shortcut: Android 10+ seulement ; avant, écrire hors de l'appli demande une permission de stockage. À ajouter si de vieux téléphones comptent.
            if (Build.VERSION.SDK_INT < 29) return "";
            Uri uri = null;
            try {
                File file = new File(path).getCanonicalFile();
                if (!file.isFile() || !file.getPath().startsWith(exports().getCanonicalPath() + File.separator)) return ""; // la page ne sort que des exports
                String type = mime(path);
                boolean image = type != null && type.startsWith("image/"), video = type != null && type.startsWith("video/");
                String dir = (image ? Environment.DIRECTORY_PICTURES : video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_DOWNLOADS) + "/ChaosClip";
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, file.getName());
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, dir);
                if (type != null) values.put(MediaStore.MediaColumns.MIME_TYPE, type);
                uri = getContentResolver().insert(image ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                        : video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                try (InputStream in = new FileInputStream(file); OutputStream out = getContentResolver().openOutputStream(uri)) {
                    copy(in, out);
                }
                return dir;
            } catch (Exception e) {
                if (uri != null) getContentResolver().delete(uri, null, null); // pas de fichier vide laissé dans la galerie
                return "";
            }
        }

        // Lance l'installation de la mise à jour que le serveur vient de télécharger (lib/updater.js).
        // Aucun chemin ne vient de la page ; Android demande confirmation et refuse un APK signé avec une autre clé.
        @JavascriptInterface
        public void install() {
            Uri apk = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", update());
            startActivity(new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(apk, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        }

        // Texte du presse-papiers, pour coller un lien d'un appui (la page n'y a pas accès toute seule).
        @JavascriptInterface
        public String paste() {
            ClipData clip = ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).getPrimaryClip();
            return clip != null && clip.getItemCount() > 0 ? String.valueOf(clip.getItemAt(0).coerceToText(MainActivity.this)) : "";
        }

        // Connexion à Chaos Tools sans copier de jeton : voir openLogin.
        @JavascriptInterface
        public void booruLogin() {
            runOnUiThread(MainActivity.this::openLogin);
        }

        // Avancement global des tâches de la page : p de 0 à 1, négatif quand plus rien ne tourne.
        @JavascriptInterface
        public void progress(double p, String text) {
            runOnUiThread(() -> work(p < 0 ? -1 : (int) Math.round(p * 100), text));
        }
    }

    // Tient WorkService en marche tant qu'une tâche tourne, puis prévient de la fin si l'appli n'est plus à l'écran.
    private void work(int next, String text) {
        handler.removeCallbacksAndMessages(null);
        NotificationManager notices = getSystemService(NotificationManager.class);
        if (next < 0) {
            if (percent < 0) return;
            // Deux tâches peuvent s'enchaîner (téléchargement puis import) : on attend un peu avant de conclure,
            // d'autant qu'Android refuse de relancer le service une fois l'appli en arrière-plan.
            handler.postDelayed(() -> {
                percent = -1;
                stopService(new Intent(this, WorkService.class));
                if (!visible) notices.notify(WorkService.DONE, WorkService.notice(this, text, -1));
            }, 2000);
        } else if (percent < 0) {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 2); // refusée : le service tourne quand même, sans rien afficher
            try {
                ContextCompat.startForegroundService(this, new Intent(this, WorkService.class).putExtra("text", text).putExtra("percent", next));
                percent = next;
            } catch (IllegalStateException e) { /* tâche lancée appli en arrière-plan : on réessaiera au prochain avancement */ }
        } else if (next != percent) { // un avis par point de pourcentage : Android en jette au-delà de quelques-uns par seconde
            notices.notify(WorkService.ONGOING, WorkService.notice(this, text, next));
            percent = next;
        }
    }

    // Comme sur PC : le site s'ouvre, on s'y connecte par Discord, puis l'appli lit le jeton que le site a rangé.
    // Cette page-là est une WebView à part, sans accès au pont ChaosClipAndroid ; Retour la referme.
    private void openLogin() {
        if (login != null) return;
        login = new WebView(this);
        login.getSettings().setJavaScriptEnabled(true);
        login.getSettings().setDomStorageEnabled(true);
        login.setWebViewClient(new WebViewClient()); // tout reste dans cette vue, page Discord comprise
        ((FrameLayout) web.getParent()).addView(login);
        login.loadUrl(CHAOSTOOLS);
        pollLogin();
    }

    private void pollLogin() {
        if (login == null) return;
        login.evaluateJavascript(TOKEN_SCRIPT, value -> {
            if (login == null) return;
            String token = String.valueOf(value).replace("\"", "");
            if (!token.matches("[\\w-]+\\.[\\w-]+\\.[\\w-]+")) { // forme d'un jeton, rien d'autre : il part dans du JavaScript
                login.postDelayed(this::pollLogin, 1000);
                return;
            }
            closeLogin();
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('chaosclip-booru',{detail:'" + token + "'}))", null);
        });
    }

    private void closeLogin() {
        ((FrameLayout) web.getParent()).removeView(login);
        login.destroy();
        login = null;
    }

    @Override
    protected void onStart() {
        super.onStart();
        visible = true;
        getSystemService(NotificationManager.class).cancel(WorkService.DONE);
    }

    @Override
    protected void onStop() {
        super.onStop();
        visible = false;
    }

    // La page disparaît avec l'activité : plus personne n'arrêterait le service.
    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        stopService(new Intent(this, WorkService.class));
        super.onDestroy();
    }

    private static String mime(String path) {
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(path.substring(path.lastIndexOf('.') + 1).toLowerCase());
    }

    private static void copy(InputStream in, OutputStream out) throws java.io.IOException {
        byte[] buf = new byte[65536];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
    }

    private File update() {
        return new File(getCacheDir(), "maj/ChaosClip.apk");
    }

    private File exports() {
        File external = getExternalFilesDir("exports");
        return external != null ? external : new File(getFilesDir(), "exports");
    }

    private void boot() {
        try {
            synchronized (MainActivity.class) {
                if (!started) {
                    File ytdlp = new File(getNoBackupFilesDir(), "youtubedl-android/yt-dlp/yt-dlp");
                    boolean bundled = !ytdlp.exists();
                    YoutubeDL.getInstance().init(this); // extrait Python et yt-dlp au premier lancement
                    FFmpeg.getInstance().init(this);
                    // Le yt-dlp livré dans l'APK peut dater : daté « vieux », lib/ytdlp.js le met à jour dès le premier lancement.
                    if (bundled) ytdlp.setLastModified(0);
                    update().delete(); // l'APK d'une mise à jour déjà installée (ou abandonnée)
                    File project = new File(getFilesDir(), "nodejs-project");
                    unpackProject(project);
                    setEnv();
                    String main = new File(project, "server.js").getPath();
                    new Thread(() -> startNode(new String[]{"node", main})).start();
                    started = true;
                }
            }
            waitForServer();
            runOnUiThread(() -> {
                CookieManager.getInstance().setCookie(ORIGIN, "cc=" + TOKEN);
                web.loadUrl(ORIGIN);
            });
        } catch (Exception e) {
            String msg = TextUtils.htmlEncode(String.valueOf(e));
            runOnUiThread(() -> web.loadData("<h3>ChaosClip n’a pas pu démarrer</h3><pre>" + msg + "</pre>", "text/html; charset=utf-8", null));
        }
    }

    // Node a besoin de vrais fichiers : le projet (zip dans les assets) est déballé à chaque nouvelle version de l'APK.
    private void unpackProject(File dir) throws Exception {
        long stamp = getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
        SharedPreferences prefs = getPreferences(MODE_PRIVATE);
        if (dir.isDirectory() && prefs.getLong("project", 0) == stamp) return;
        delete(dir);
        try (ZipInputStream zip = new ZipInputStream(getAssets().open("nodejs-project.zip"))) {
            for (ZipEntry e; (e = zip.getNextEntry()) != null; ) {
                File out = new File(dir, e.getName());
                if (e.isDirectory()) { out.mkdirs(); continue; }
                out.getParentFile().mkdirs();
                try (OutputStream os = new FileOutputStream(out)) {
                    copy(zip, os);
                }
            }
        }
        prefs.edit().putLong("project", stamp).apply();
    }

    private static void delete(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) delete(c);
        f.delete();
    }

    // Les chemins que lib/env.js et lib/ytdlp.js lisent, et ce dont les binaires Termux ont besoin pour trouver leurs bibliothèques.
    private void setEnv() throws Exception {
        String bin = getApplicationInfo().nativeLibraryDir;
        File packages = new File(getNoBackupFilesDir(), "youtubedl-android/packages");
        String python = new File(packages, "python/usr").getPath();
        env("CHAOSCLIP_TOKEN", TOKEN);
        env("CHAOSCLIP_DATA", new File(getFilesDir(), "chaosclip").getPath());
        env("CHAOSCLIP_EXPORTS", exports().getPath());
        env("CHAOSCLIP_APK_DIR", update().getParent());
        env("NO_OPEN", "1");
        env("HOME", getFilesDir().getPath());
        env("TMPDIR", getCacheDir().getPath());
        env("FFMPEG_PATH", bin + "/libffmpeg.so");
        env("FFPROBE_PATH", bin + "/libffprobe.so");
        env("YTDLP_PYTHON", bin + "/libpython.so");
        env("YTDLP_QJS", bin + "/libqjs.so");
        env("YTDLP_PATH", new File(getNoBackupFilesDir(), "youtubedl-android/yt-dlp/yt-dlp").getPath());
        env("PYTHONHOME", python);
        env("SSL_CERT_FILE", python + "/etc/tls/cert.pem");
        env("LD_LIBRARY_PATH", python + "/lib:" + new File(packages, "ffmpeg/usr/lib").getPath());
        env("PATH", System.getenv("PATH") + ":" + bin);
    }

    private static void env(String name, String value) throws Exception {
        Os.setenv(name, value, true);
    }

    private void waitForServer() throws Exception {
        for (int i = 0; i < 240; i++) { // 60 s : le premier lancement déballe tout
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(ORIGIN + "/").openConnection();
                c.setRequestProperty("Cookie", "cc=" + TOKEN);
                c.setConnectTimeout(500);
                int code = c.getResponseCode();
                c.disconnect();
                if (code == 200) return;
            } catch (java.io.IOException ignored) { /* pas encore prêt */ }
            Thread.sleep(250);
        }
        throw new IllegalStateException("Le serveur ne répond pas (voir logcat, étiquette ChaosClipNode).");
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request != 1 || fileCallback == null) return;
        fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (login != null) {
            if (login.canGoBack()) login.goBack();
            else closeLogin();
            return;
        }
        // La page ferme d'abord ce qui est ouvert (fenêtre, menu : voir chaosclipBack dans main.js).
        // Sinon l'appli passe à l'arrière-plan sans s'arrêter : la page et les tâches en cours restent en place.
        web.evaluateJavascript("window.chaosclipBack ? window.chaosclipBack() : false", closed -> {
            if (!"true".equals(closed)) moveTaskToBack(true);
        });
    }
}
