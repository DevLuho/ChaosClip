package fr.devluho.chaosclip;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationChannelCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

// Service au premier plan : tant qu'un export ou un téléchargement tourne, Android ne suspend pas l'appli
// quand on passe sur une autre ou que l'écran s'éteint. MainActivity le démarre et l'arrête (work).
public class WorkService extends Service {
    static final int ONGOING = 1, DONE = 2;

    private PowerManager.WakeLock awake;

    // percent < 0 : avis de fin, qui sonne et s'efface d'un geste ; sinon avancement (0 = pas encore mesuré).
    static Notification notice(Context c, String text, int percent) {
        boolean done = percent < 0;
        String channel = done ? "fin" : "travail";
        NotificationManagerCompat.from(c).createNotificationChannel(new NotificationChannelCompat
                .Builder(channel, done ? NotificationManagerCompat.IMPORTANCE_DEFAULT : NotificationManagerCompat.IMPORTANCE_LOW)
                .setName(done ? "Fin d’un export ou d’un téléchargement" : "Export ou téléchargement en cours").build());
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, channel)
                .setContentTitle(text)
                .setContentIntent(PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE));
        if (done) return b.setSmallIcon(android.R.drawable.stat_sys_download_done).setAutoCancel(true).build();
        return b.setSmallIcon(android.R.drawable.stat_sys_download).setOngoing(true)
                .setProgress(100, percent, percent == 0).setContentText(percent > 0 ? percent + " %" : null).build();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        // Écran éteint, le processeur s'endort sans ce verrou, service au premier plan ou pas.
        awake = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "chaosclip:travail");
        awake.acquire(3 * 3600_000L); // shortcut: 3 h au plus, pour ne jamais vider la batterie si l'arrêt se perd ; à allonger si un export les dépasse
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) stopSelf();
        else startForeground(ONGOING, notice(this, intent.getStringExtra("text"), intent.getIntExtra("percent", 0)));
        return START_NOT_STICKY;
    }

    // Android 15+ : un service « dataSync » a droit à 6 h par jour, puis doit s'arrêter de lui-même (sinon l'appli est tuée).
    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (awake.isHeld()) awake.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
