// État de la mémoire du serveur, donné aux agents (patron, contrôle horaire) : ils ne peuvent pas lancer de commande
// système eux-mêmes, et sans cette mesure ils répétaient une alerte « mémoire pleine » vue dans de vieux journaux alors
// qu'elle avait été libérée (01/11 : 1,9 Go puis 15 Go de mémoire validée libre après l'arrêt d'Ollama inactif).
// La limite qui compte est la mémoire validée (RAM + fichier d'échange) : à zéro, Python s'arrête (MemoryError, code
// 3221225773) et les ordres du bot échouent.
const { spawnSync } = require("child_process");

function memory() {
  if (process.platform !== "win32") return null;
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    "$o = Get-CimInstance Win32_OperatingSystem; $p = Get-CimInstance Win32_PageFileUsage | Select-Object -First 1; " +
    "'{0} {1} {2} {3} {4}' -f $o.FreeVirtualMemory, $o.TotalVirtualMemorySize, $o.FreePhysicalMemory, $p.CurrentUsage, $p.AllocatedBaseSize"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const [freeV, totalV, freeP, pfUsed, pfSize] = String(r.stdout || "").trim().split(/\s+/).map(Number);
  if (!totalV) return null;
  const go = (kb) => Math.round((kb / 1048576) * 10) / 10;
  return { lu_a: new Date().toISOString(), memoire_validee_libre_go: go(freeV), memoire_validee_totale_go: go(totalV), ram_libre_go: go(freeP),
    fichier_echange_utilise_pct: pfSize ? Math.round((pfUsed / pfSize) * 100) : null,
    lecture: freeV / 1048576 < 2 ? "PLEINE : risque de MemoryError pour les ordres du bot" : freeV / 1048576 < 5 ? "basse" : "correcte" };
}

module.exports = { memory };
