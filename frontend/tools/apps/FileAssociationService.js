import path from 'node:path';
export class FileAssociationService {
  constructor(processService){this.processService=processService;}
  async resolve(target,apps) {
    if(!target.path||target.type==='FOLDER')return null;
    const extension=path.win32.extname(target.path);
    if(!/^\.[a-z0-9]{1,20}$/i.test(extension))return null;
    const command=await this.processService._runPS(`$ext='${extension}';$choice=Get-ItemProperty -LiteralPath "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\$ext\\UserChoice" -ErrorAction SilentlyContinue;$id=$choice.ProgId;if(!$id){$k=Get-Item -LiteralPath "Registry::HKEY_CLASSES_ROOT\\$ext" -ErrorAction SilentlyContinue;if($k){$id=$k.GetValue('')}};if($id){$key=Get-Item -LiteralPath "Registry::HKEY_CLASSES_ROOT\\$id\\shell\\open\\command" -ErrorAction SilentlyContinue;if($key){$key.GetValue('')|ConvertTo-Json -Compress}}`);
    // Never execute an association command. Accept only an executable + one target placeholder.
    const match=typeof command==='string'&&command.match(/^"([^"\r\n]+\.exe)"\s+"?%[1l]"?\s*$/i);
    return match?apps.find(a=>a.available && a.launchType==='executable' && a.executablePath?.toLowerCase()===match[1].toLowerCase()):null;
  }
}
