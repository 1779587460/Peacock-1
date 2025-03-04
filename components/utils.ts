/*
 *     The Peacock Project - a HITMAN server replacement.
 *     Copyright (C) 2021-2023 The Peacock Project Team
 *
 *     This program is free software: you can redistribute it and/or modify
 *     it under the terms of the GNU Affero General Public License as published by
 *     the Free Software Foundation, either version 3 of the License, or
 *     (at your option) any later version.
 *
 *     This program is distributed in the hope that it will be useful,
 *     but WITHOUT ANY WARRANTY; without even the implied warranty of
 *     MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *     GNU Affero General Public License for more details.
 *
 *     You should have received a copy of the GNU Affero General Public License
 *     along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { decode } from "jsonwebtoken"
import type { NextFunction, Response } from "express"
import type {
    MissionManifestObjective,
    RepositoryId,
    RequestWithJwt,
    ServerVersion,
    Unlockable,
    UserProfile,
} from "./types/types"
import axios, { AxiosError } from "axios"
import { log, LogLevel } from "./loggingInterop"
import { writeFileSync } from "fs"
import { getFlag } from "./flags"

/**
 * True if the server is being run by the launcher, false otherwise.
 */
export const IS_LAUNCHER = process.env.IS_PEACOCK_LAUNCHER === "true"

export const ServerVer: ServerVersion = {
    _Major: 8,
    _Minor: 10,
    _Build: 0,
    _Revision: 0,
}

export const PEACOCKVER = REV_IDENT
export const PEACOCKVERSTRING = HUMAN_VERSION

export const uuidRegex =
    /^[a-zA-Z0-9]{8}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{12}$/

export const contractTypes = ["featured", "usercreated", "creation"]

export const contractCreationTutorialId = "d7e2607c-6916-48e2-9588-976c7d8998bb"

export async function checkForUpdates(): Promise<void> {
    if (getFlag("updateChecking") === false) {
        return
    }

    try {
        const res = await axios(
            "https://backend.rdil.rocks/peacock/latest-version",
        )
        const current = res.data

        if (current === PEACOCKVER) {
            log(LogLevel.DEBUG, "Peacock is up to date.")
        } else {
            log(
                LogLevel.WARN,
                `Peacock is out-of-date! Check the Discord for the latest release.`,
            )
        }
    } catch (e) {
        log(LogLevel.WARN, "Failed to check for updates!")
    }
}

/**
 * Middleware that validates the authentication token sent by the client.
 *
 * @param req The express request object.
 * @param res The express response object.
 * @param next The express next function.
 */
export function extractToken(
    req: RequestWithJwt,
    res?: Response,
    next?: NextFunction,
): void {
    const header = req.header("Authorization")
    const auth = header ? header.split(" ") : []

    if (auth.length === 2 && auth[0].toLowerCase() === "bearer") {
        // @ts-expect-error Type overlap
        req.jwt = <string>decode(auth[1])

        if (!uuidRegex.test(req.jwt.unique_name)) {
            res?.status(424).send("profile appears to be corrupted")
            return
        }

        next?.()
        return
    }

    req.shouldCease = true
    next?.("router")
}

export function xpRequiredForLevel(level: number): number {
    return level * 6000 - 6000
}

export function castUserProfile(profile: UserProfile): UserProfile {
    const j = fastClone(profile)

    if (!j.Extensions || Object.keys(j.Extensions).length === 0) {
        log(LogLevel.DEBUG, "No extensions - skipping validation")
        return j
    }

    let dirty = false

    for (const item of [
        "PeacockEscalations",
        "PeacockFavoriteContracts",
        "PeacockCompletedEscalations",
        "CPD",
    ]) {
        if (!Object.prototype.hasOwnProperty.call(j.Extensions, item)) {
            log(LogLevel.DEBUG, `Err missing property ${item}`)
            log(
                LogLevel.WARN,
                `A requested user profile is missing some vital data.`,
            )
            log(
                LogLevel.WARN,
                `Attempting to repair the profile automatically...`,
            )

            if (item === "PeacockEscalations") {
                j.Extensions.PeacockEscalations = {}
            }

            if (item === "PeacockCompletedEscalations") {
                j.Extensions.PeacockCompletedEscalations = []
            }

            if (item === "PeacockFavoriteContracts") {
                j.Extensions.PeacockFavoriteContracts = []
            }

            if (item === "CPD") {
                j.Extensions.CPD = {}
            }

            dirty = true
        }
    }

    if (dirty) {
        writeFileSync(`userdata/users/${j.Id}.json`, JSON.stringify(j))
        log(LogLevel.INFO, "Profile successfully repaired!")
    }

    return j
}

export function getDefaultSuitFor(location: string) {
    switch (location) {
        case "LOCATION_PARENT_ICA_FACILITY":
            return "TOKEN_OUTFIT_GREENLAND_HERO_TRAININGSUIT"
        case "LOCATION_PARENT_PARIS":
            return "TOKEN_OUTFIT_PARIS_HERO_PARISSUIT"
        case "LOCATION_PARENT_COASTALTOWN":
            return "TOKEN_OUTFIT_SAPIENZA_HERO_SAPIENZASUIT"
        case "LOCATION_PARENT_MARRAKECH":
            return "TOKEN_OUTFIT_MARRAKESH_HERO_MARRAKESHSUIT"
        case "LOCATION_PARENT_BANGKOK":
            return "TOKEN_OUTFIT_BANGKOK_HERO_BANGKOKSUIT"
        case "LOCATION_PARENT_COLORADO":
            return "TOKEN_OUTFIT_COLORADO_HERO_COLORADOSUIT"
        case "LOCATION_PARENT_HOKKAIDO":
            return "TOKEN_OUTFIT_HOKKAIDO_HERO_HOKKAIDOSUIT"
        case "LOCATION_PARENT_NEWZEALAND":
            return "TOKEN_OUTFIT_NEWZEALAND_HERO_NEWZEALANDSUIT"
        case "LOCATION_PARENT_MIAMI":
            return "TOKEN_OUTFIT_MIAMI_HERO_MIAMISUIT"
        case "LOCATION_PARENT_COLOMBIA":
            return "TOKEN_OUTFIT_COLOMBIA_HERO_COLOMBIASUIT"
        case "LOCATION_PARENT_MUMBAI":
            return "TOKEN_OUTFIT_MUMBAI_HERO_MUMBAISUIT"
        case "LOCATION_PARENT_NORTHAMERICA":
            return "TOKEN_OUTFIT_NORTHAMERICA_HERO_NORTHAMERICASUIT"
        case "LOCATION_PARENT_NORTHSEA":
            return "TOKEN_OUTFIT_NORTHSEA_HERO_NORTHSEASUIT"
        case "LOCATION_PARENT_GREEDY":
            return "TOKEN_OUTFIT_GREEDY_HERO_GREEDYSUIT"
        case "LOCATION_PARENT_OPULENT":
            return "TOKEN_OUTFIT_OPULENT_HERO_OPULENTSUIT"
        case "LOCATION_PARENT_GOLDEN":
            return "TOKEN_OUTFIT_HERO_GECKO_SUIT"
        case "LOCATION_PARENT_ANCESTRAL":
            return "TOKEN_OUTFIT_ANCESTRAL_HERO_ANCESTRALSUIT"
        case "LOCATION_PARENT_EDGY":
            return "TOKEN_OUTFIT_EDGY_HERO_EDGYSUIT"
        case "LOCATION_PARENT_WET":
            return "TOKEN_OUTFIT_WET_HERO_WETSUIT"
        case "LOCATION_PARENT_ELEGANT":
            return "TOKEN_OUTFIT_ELEGANT_HERO_LLAMASUIT"
        case "LOCATION_PARENT_ROCKY":
            return "TOKEN_OUTFIT_HERO_DUGONG_SUIT"
        default:
            return "TOKEN_OUTFIT_HITMANSUIT"
    }
}

export const nilUuid = "00000000-0000-0000-0000-000000000000"

export function isObjectiveActive(
    objective: MissionManifestObjective,
    doneObjectives: Set<RepositoryId>,
): boolean {
    if (objective.Activation !== undefined) {
        if (Array.isArray(objective.Activation.$eq)) {
            return (
                objective.Activation.$eq[1] === "Completed" &&
                doneObjectives.has(
                    (<string>objective.Activation.$eq[0]).substring(1),
                )
            )
        }
    }
    return false
}

export const jokes = [
    "STILL... we are close now, 47.",
    "James Batty, the plaintiff, wants Janus to stop his annual landing of a helicopter, near the local creek.",
    "Searching for local masons in your area...",
    "I wonder what kind of curry currymaker makes",
    "Listening for uncommon guard voice lines...",
    "Mistah Jason Portman, please come to the hospital entrance. A doctor will escort you to your checkup. That was for: mistah Jason Portman.",
    "Nakamura-San, please come to the operating theatre. Stat.",
    "Ugh, my knee is so sore.",
    "Mister Prichard I presume? Hi, I'm Chen Ting. Pleasure to meet you.",
    "Find your inner... zen",
    "I love those little drones when they scoot around like that.",
    "Welcome, welcome! Hello! Good to see you. So lovely to see so many familiar faces here today.",
    "hi so i own hitman 1 and 2 i got hitman 1 and 2 on disc hitman 1 def edition and hitman 2 gold disc both on ps4 and when i got hitman 2 i downloaded the best legesy pack and all of my saves are on hitman 2 but i got rid of that game will i need both of them to get all the levels onto hitman 3 and im staying on ps4",
    "The weather is always nice in Paris.",
    "Have you seen a girl around? Short hair, with a bright green bag?",
    "The show is just about to start.",
    "Entering the Ether lab requires a uniform and a keycard... luckily, it seems both are within reach.",
    "Welcome to Bangkok, 47. The target has been in residence at the hotel for almost a month and security is tight, with several other high-profile guests also at the hotel. Good Hunting.",
]

/**
 * The current game difficulty.
 */
export const gameDifficulty = {
    /**
     * The game isn't on a set difficulty (missions with no difficulties data?).
     */
    unset: 0,
    /**
     * Casual mode.
     */
    casual: 1,
    /**
     * Professional (normal) mode.
     */
    normal: 2,
    /**
     * Master mode.
     */
    master: 4,
} as const

export function difficultyToString(difficulty: number): string {
    switch (difficulty) {
        case 1:
            return "casual"
        case 2:
            return "normal"
        case 4:
            return "master"
        case 0:
        default:
            return "unset"
    }
}

/**
 * Handle an {@link AxiosError} from axios.
 *
 * @see https://axios-http.com/docs/handling_errors
 * @param error The error from axios.
 */
export function handleAxiosError(error: AxiosError): void {
    if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        log(LogLevel.DEBUG, `code ${error.response.status}`)
    } else if (error.request) {
        // The request was made but no response was received
        // `error.request` is an instance of http.ClientRequest
        log(LogLevel.DEBUG, `bad fetch`)
    } else {
        // Something happened in setting up the request that triggered an Error
        log(LogLevel.DEBUG, `generic`)
    }
}

export function unlockOrderComparer(a: Unlockable, b: Unlockable): number {
    return (
        (a?.Properties?.UnlockOrder ?? Number.POSITIVE_INFINITY) -
            (b?.Properties?.UnlockOrder ?? Number.POSITIVE_INFINITY) || 0
    )
}

/**
 * Converts a contract's public ID as a long-form number into the version with dashes.
 *
 * @param publicId The ID without dashes.
 * @returns The ID with dashes.
 */
export function addDashesToPublicId(publicId: string): string {
    if (publicId.includes("-")) {
        // this work is already done
        return publicId
    }

    let id = publicId
    id = id.slice(0, 1) + "-" + id.slice(1)
    id = id.slice(0, 4) + "-" + id.slice(4)
    id = id.slice(0, 12) + "-" + id.slice(12)
    return id
}

/**
 * A fast implementation of deep object cloning.
 *
 * @param item The item to clone.
 * @returns The new item.
 */
export function fastClone<T>(item: T): T {
    // null, undefined values check
    if (!item) {
        return item
    }

    const types = [Number, String, Boolean]
    let result

    // normalizing primitives if someone did new String("aaa"), or new Number("444")
    for (const type of types) {
        if (item instanceof type) {
            result = type(item)
        }
    }

    if (typeof result === "undefined") {
        if (Array.isArray(item)) {
            result = []

            // Ugly type casting.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const itemAsArray: Array<typeof item> = item as any

            itemAsArray.forEach((child, index) => {
                result[index] = fastClone(child)
            })
        } else if (typeof item === "object") {
            // this is a literal
            if (item instanceof Date) {
                result = new Date(item)
            } else {
                // object literal
                result = {}
                for (const i in item) {
                    result[i] = fastClone(item[i])
                }
            }
        } else {
            result = item
        }
    }

    return result
}
