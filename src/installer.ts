import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as tc from '@actions/tool-cache'

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import * as semver from 'semver'

// Translations between actions input and Julia arch names
const osMap = {
    'win32': 'winnt',
    'darwin': 'mac',
    'linux': 'linux'
}
const archMap = {
    'x86': 'i686',
    'x64': 'x86_64'
}

// Store information about the environment
const osPlat = osMap[os.platform()] // possible values: win32 (Windows), linux (Linux), darwin (macOS)
core.debug(`platform: ${osPlat}`)

/**
 * @returns The content of the downloaded versions.json file as object.
 */
export async function getJuliaVersionInfo(): Promise<object> {
    let versionsFile = tc.find('julia-versions', 'latest')
    if (!versionsFile) {
        versionsFile = await tc.downloadTool('https://julialang-s3.julialang.org/bin/versions.json')
        tc.cacheFile(versionsFile, 'versions.json', 'julia-versions', 'latest')
    }

    return JSON.parse(fs.readFileSync(versionsFile).toString())
}

/**
 * @returns An array of all Julia versions available for download
 */
export async function getJuliaVersions(versionInfo): Promise<string[]> {
    let versions: string[] = []

    for (var version in versionInfo) {
        versions.push(version)
    }

    return versions
}

export async function getJuliaVersion(availableReleases: string[], versionInput: string): Promise<string> {
    if (semver.valid(versionInput) == versionInput) {
        // versionInput is a valid version, use it directly
        return versionInput
    }

    // nightlies
    if (versionInput == 'nightly') {
        return 'nightly'
    }

    // Use the highest available version that matches versionInput
    let version = semver.maxSatisfying(availableReleases, versionInput)
    if (version == null) {
        throw `Could not find a Julia version that matches ${versionInput}`
    }

    // GitHub tags start with v, remove it
    version = version.replace(/^v/, '')

    return version
}

function getNightlyFileName(arch: string): string {
    let versionExt: string, ext: string

    if (osPlat == 'winnt') {
        versionExt = arch == 'x64' ? '-win64' : '-win32'
        ext = 'exe'
    } else if (osPlat == 'mac') {
        if (arch == 'x86') {
            throw '32-bit Julia is not available on macOS'
        }
        versionExt = '-mac64'
        ext = 'dmg'
    } else if (osPlat === 'linux') {
        versionExt = arch == 'x64' ? '-linux64' : '-linux32'
        ext = 'tar.gz'
    } else {
        throw `Platform ${osPlat} is not supported`
    }

    return `julia-latest${versionExt}.${ext}`
}

export async function getDownloadURL(versionInfo, version: string, arch: string): Promise<string> {
    // nightlies
    if (version == 'nightly') {
        const baseURL = 'https://julialangnightlies-s3.julialang.org/bin'
        return `${baseURL}/${osPlat}/${arch}/${getNightlyFileName(arch)}`
    }

    versionInfo['1.3.0-rc3'].files.forEach(file => {
        if (file.os == osPlat && file.arch == archMap[arch]) {
            return file.url
        }
    })

    throw `Could not find ${archMap[arch]}/${version} binaries`
}

export async function installJulia(version: string, arch: string): Promise<string> {
    // Download Julia
    const downloadURL = await getDownloadURL(await getJuliaVersionInfo(), version, arch)
    core.debug(`downloading Julia from ${downloadURL}`)
    const juliaDownloadPath = await tc.downloadTool(downloadURL)

    // Install it
    switch (osPlat) {
        case 'linux':
            // tc.extractTar doesn't support stripping components, so we have to call tar manually
            await exec.exec('mkdir', [`${process.env.HOME}/julia`])
            await exec.exec('tar', ['xf', juliaDownloadPath, '--strip-components=1', '-C', `${process.env.HOME}/julia`])
            return `${process.env.HOME}/julia`
        case 'win32':
            const juliaInstallationPath = path.join('C:', 'Julia')
            if (version == 'nightly' || semver.gtr(version, '1.3', { includePrerelease: true })) {
                // The installer changed in 1.4: https://github.com/JuliaLang/julia/blob/ef0c9108b12f3ae177c51037934351ffa703b0b5/NEWS.md#build-system-changes
                await exec.exec('powershell', ['-Command', `Start-Process -FilePath ${juliaDownloadPath} -ArgumentList "/SILENT /dir=${juliaInstallationPath}" -NoNewWindow -Wait`])
            } else {
                await exec.exec('powershell', ['-Command', `Start-Process -FilePath ${juliaDownloadPath} -ArgumentList "/S /D=${juliaInstallationPath}" -NoNewWindow -Wait`])
            }
            return juliaInstallationPath
        case 'darwin':
            await exec.exec('hdiutil', ['attach', juliaDownloadPath])
            await exec.exec('mkdir', [`${process.env.HOME}/julia`])
            await exec.exec('/bin/bash', ['-c', `cp -a /Volumes/Julia-*/Julia-*.app/Contents/Resources/julia ${process.env.HOME}`])
            return `${process.env.HOME}/julia`
        default:
            throw `Platform ${osPlat} is not supported`
    }
}
