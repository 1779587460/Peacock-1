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

import type {
    ChallengeProgressionData,
    ChallengeTreeWaterfallState,
    ClientToServerEvent,
    CompiledChallengeTreeCategory,
    CompiledChallengeTreeData,
    ContractSession,
    GameVersion,
    MissionManifest,
    PeacockLocationsData,
    RegistryChallenge,
    Unlockable,
    UserProfile,
} from "../types/types"
import { getUserData, writeUserData } from "../databaseHandler"

import { Controller } from "../controller"
import {
    generateCompletionData,
    generateUserCentric,
    getSubLocationFromContract,
} from "../contracts/dataGen"
import { log, LogLevel } from "../loggingInterop"
import {
    parseContextListeners,
    ParsedContextListenerInfo,
} from "../statemachines/contextListeners"
import {
    handleEvent,
    HandleEventOptions,
} from "@peacockproject/statemachine-parser"
import { SavedChallengeGroup } from "../types/challenges"
import { fastClone } from "../utils"
import {
    ChallengeFilterOptions,
    ChallengeFilterType,
    filterChallenge,
} from "./challengeHelpers"
import assert from "assert"
import { getVersionedConfig } from "../configSwizzleManager"
import { SyncHook } from "../hooksImpl"

type ChallengeDefinitionLike = {
    Context?: Record<string, unknown>
}

type Compiler = (
    challenge: RegistryChallenge,
    progression: ChallengeProgressionData,
    gameVersion: GameVersion,
    userId: string,
) => CompiledChallengeTreeData

type GroupIndexedChallengeLists = {
    [groupId: string]: RegistryChallenge[]
}

/**
 * A base class providing challenge registration support.
 */
export abstract class ChallengeRegistry {
    protected challenges: Map<string, RegistryChallenge> = new Map()
    protected groups: Map<string, SavedChallengeGroup> = new Map()
    protected groupContents: Map<string, Set<string>> = new Map()
    /**
     * A map of a challenge ID to a list of challenge IDs that it depends on.
     */
    protected readonly _dependencyTree: Map<string, readonly string[]> =
        new Map()

    protected constructor(protected readonly controller: Controller) {}

    registerChallenge(challenge: RegistryChallenge, groupId: string): void {
        challenge.inGroup = groupId
        this.challenges.set(challenge.Id, challenge)

        if (!this.groupContents.has(groupId)) {
            this.groupContents.set(groupId, new Set())
        }

        const set = this.groupContents.get(groupId)!
        set.add(challenge.Id)
        this.groupContents.set(groupId, set)

        this.checkHeuristics(challenge)
    }

    registerGroup(group: SavedChallengeGroup): void {
        this.groups.set(group.CategoryId, group)
    }

    getChallengeById(challengeId: string): RegistryChallenge | undefined {
        return this.challenges.get(challengeId)
    }

    getGroupById(groupId: string): SavedChallengeGroup | undefined {
        return this.groups.get(groupId)
    }

    getDependenciesForChallenge(challengeId: string): readonly string[] {
        return this._dependencyTree.get(challengeId) || []
    }

    protected checkHeuristics(challenge: RegistryChallenge): void {
        const ctxListeners = ChallengeRegistry._parseContextListeners(challenge)

        if (ctxListeners.challengeTreeIds.length > 0) {
            this._dependencyTree.set(
                challenge.Id,
                ctxListeners.challengeTreeIds,
            )
        }
    }

    /**
     * Parse a challenge's context listeners into the format used internally.
     *
     * @param challenge The challenge.
     * @returns The context listener details.
     */
    protected static _parseContextListeners(
        challenge: RegistryChallenge,
    ): ParsedContextListenerInfo {
        return parseContextListeners(
            challenge.Definition?.ContextListeners || {},
            {
                ...(challenge.Definition?.Context || {}),
                ...(challenge.Definition?.Constants || {}),
            },
        )
    }
}

export class ChallengeService extends ChallengeRegistry {
    public hooks: {
        /**
         * A hook that is called when a challenge is completed.
         *
         * Params:
         * - userId: The user's ID.
         * - challenge: The challenge.
         * - gameVersion: The game version.
         */
        onChallengeCompleted: SyncHook<[string, RegistryChallenge, GameVersion]>
    }

    constructor(controller: Controller) {
        super(controller)
        this.hooks = {
            onChallengeCompleted: new SyncHook(),
        }
    }

    /**
     * Same concept as {@link getPersistentChallengeProgression},
     * but significantly faster. Why? Because it doesn't need to load the user's
     * data, check dependencies, etc. It's just a yes or no.
     *
     * @param userData The user's data object. Will not be modified.
     * @param challengeId The ID of the challenge.
     * @returns Whether the challenge is completed.
     * @see getPersistentChallengeProgression
     */
    fastGetIsCompleted(
        userData: Readonly<UserProfile>,
        challengeId: string,
    ): boolean {
        return (
            userData.Extensions.ChallengeProgression[challengeId]?.Completed ||
            false
        )
    }

    /**
     * Same concept as {@link fastGetIsCompleted},
     * but for if a challenge is unticked.
     *
     * @param userData The user's data object. Will not be modified.
     * @param challengeId The ID of the challenge.
     * @returns Whether the challenge is completed and unticked.
     * @see fastGetIsCompleted
     */
    fastGetIsUnticked(
        userData: Readonly<UserProfile>,
        challengeId: string,
    ): boolean {
        const progression =
            userData.Extensions.ChallengeProgression[challengeId]
        return (progression?.Completed && !progression.Ticked) || false
    }

    getPersistentChallengeProgression(
        userId: string,
        challengeId: string,
        gameVersion: GameVersion,
    ): ChallengeProgressionData {
        const userData = getUserData(userId, gameVersion)

        const challenge = this.getChallengeById(challengeId)

        userData.Extensions.ChallengeProgression ??= {}

        const data = userData.Extensions.ChallengeProgression

        // prevent game crash - when we have a challenge that is completed, we
        // need to implicitly add this key to the state
        if (data[challengeId]?.Completed) {
            data[challengeId].State = {
                CurrentState: "Success",
            }
        }

        // the default context, used if the user has no progression for this
        // challenge
        const initialContext =
            (<ChallengeDefinitionLike>challenge?.Definition)?.Context || {}

        // apply default context if no progression exists
        data[challengeId] ??= {
            Ticked: false,
            Completed: false,
            State: initialContext,
        }

        const dependencies = this.getDependenciesForChallenge(challengeId)

        if (dependencies.length > 0) {
            data[challengeId].State.CompletedChallenges = dependencies.filter(
                (depId) => this.fastGetIsCompleted(userData, depId),
            )
        }

        return {
            Completed: data[challengeId].Completed,
            Ticked: data[challengeId].Ticked,
            State: data[challengeId].State,
            ChallengeId: challengeId,
            ProfileId: userId,
            CompletedAt: null,
            MustBeSaved: true,
        }
    }

    /**
     * Get challenge lists sorted into groups.
     *
     * @param filter The filter to use.
     */
    getGroupedChallengeLists(
        filter: ChallengeFilterOptions,
    ): GroupIndexedChallengeLists {
        let challenges: [string, RegistryChallenge[]][] = []

        for (const groupId of this.groups.keys()) {
            const groupContents = this.groupContents.get(groupId)

            if (groupContents) {
                let groupChallenges: RegistryChallenge[] | string[] = [
                    ...groupContents,
                ]

                groupChallenges = groupChallenges
                    .map((challengeId) => {
                        const challenge = this.getChallengeById(challengeId)

                        // early return if the challenge is falsy
                        if (!challenge) {
                            return challenge
                        }

                        return filterChallenge(filter, challenge)
                            ? challenge
                            : undefined
                    })
                    .filter(Boolean) as RegistryChallenge[]

                challenges.push([groupId, [...groupChallenges]])
            }
        }

        // remove empty groups
        challenges = challenges.filter(
            ([, challenges]) => challenges.length > 0,
        )

        return Object.fromEntries(challenges)
    }

    getChallengesForContract(
        contractId: string,
        gameVersion: GameVersion,
    ): GroupIndexedChallengeLists {
        const contract = this.controller.resolveContract(contractId)

        assert.ok(contract)

        const contractParentLocation = getSubLocationFromContract(
            contract,
            gameVersion,
        )?.Properties.ParentLocation

        assert.ok(contractParentLocation)

        return this.getGroupedChallengeLists({
            type: ChallengeFilterType.Contract,
            contractId: contractId,
            locationId: contract.Metadata.Location,
            locationParentId: contractParentLocation,
        })
    }

    getChallengesForLocation(
        child: string,
        gameVersion: GameVersion,
    ): GroupIndexedChallengeLists {
        const locations = getVersionedConfig<PeacockLocationsData>(
            "LocationsData",
            gameVersion,
            true,
        )
        const parent = locations.children[child].Properties.ParentLocation
        const location = locations.children[child]
        assert.ok(location)

        let contracts =
            child === "LOCATION_AUSTRIA" ||
            child === "LOCATION_SALTY_SEAGULL" ||
            child === "LOCATION_CAGED_FALCON"
                ? this.controller.missionsInLocations.sniper[child]
                : this.controller.missionsInLocations[child]
        if (!contracts) {
            contracts = []
        }

        return this.getGroupedChallengeLists({
            type: ChallengeFilterType.Contracts,
            contractIds: contracts,
            locationId: child,
            locationParentId: parent,
        })
    }

    startContract(
        userId: string,
        sessionId: string,
        session: ContractSession,
    ): void {
        // we know we will have challenge contexts because this session is
        // brand new.
        const { gameVersion, contractId, challengeContexts } = session

        const challengeGroups = this.getChallengesForContract(
            contractId,
            gameVersion,
        )

        const profile = getUserData(session.userId, session.gameVersion)

        for (const group of Object.keys(challengeGroups)) {
            for (const challenge of challengeGroups[group]) {
                const isDone = this.fastGetIsCompleted(profile, challenge.Id)

                // For challenges with scopes being "profile" or "hit",
                // update challenge progression with the user's progression data
                const ctx =
                    challenge.Definition.Scope === "profile" ||
                    challenge.Definition.Scope === "hit"
                        ? profile.Extensions.ChallengeProgression[challenge.Id]
                              .State
                        : fastClone(
                              (<ChallengeDefinitionLike>challenge.Definition)
                                  ?.Context || {},
                          ) || {}

                challengeContexts[challenge.Id] = {
                    context: ctx,
                    state: isDone ? "Success" : "Start",
                    timers: [],
                }
            }
        }
    }

    onContractEvent(
        event: ClientToServerEvent,
        sessionId: string,
        session: ContractSession,
    ): void {
        if (!session.challengeContexts) {
            log(LogLevel.WARN, "Session does not have challenge contexts.")
            log(LogLevel.WARN, "Challenges will be disabled!")
            return
        }

        const userData = getUserData(session.userId, session.gameVersion)

        for (const challengeId of Object.keys(session.challengeContexts)) {
            const challenge = this.getChallengeById(challengeId)
            const data = session.challengeContexts[challengeId]

            if (!challenge) {
                log(LogLevel.WARN, `Challenge ${challengeId} not found`)
                continue
            }

            if (this.fastGetIsCompleted(userData, challengeId)) {
                continue
            }

            try {
                const options: HandleEventOptions = {
                    eventName: event.Name,
                    currentState: data.state,
                    timers: data.timers,
                    timestamp: event.Timestamp,
                }

                const previousState = data.state

                const result = handleEvent(
                    // @ts-expect-error Needs to be fixed upstream.
                    challenge.Definition,
                    fastClone(data.context),
                    event.Value,
                    options,
                )
                // For challenges with scopes being "profile" or "hit",
                // save challenge progression to the user's progression data
                if (
                    challenge.Definition.Scope === "profile" ||
                    challenge.Definition.Scope === "hit"
                ) {
                    userData.Extensions.ChallengeProgression[
                        challengeId
                    ].State = result.context

                    writeUserData(session.userId, session.gameVersion)
                }
                // Need to update session context for all challenges
                // to correctly determine challenge completion
                session.challengeContexts[challengeId].state = result.state
                session.challengeContexts[challengeId].context =
                    result.context || challenge.Definition?.Context || {}

                if (previousState !== "Success" && result.state === "Success") {
                    this.onChallengeCompleted(session, challenge)
                }
            } catch (e) {
                log(LogLevel.ERROR, e)
            }
        }
    }

    /**
     * Get the challenge tree for a contract.
     *
     * @param contractId The ID of the contract.
     * @param gameVersion The game version requesting the challenges.
     * @param userId The user requesting the challenges' ID.
     * @returns The challenge tree.
     */
    getChallengeTreeForContract(
        contractId: string,
        gameVersion: GameVersion,
        userId: string,
    ): CompiledChallengeTreeCategory[] {
        const contractData = this.controller.resolveContract(contractId)

        if (!contractData) {
            return []
        }

        const subLocation = getSubLocationFromContract(
            contractData,
            gameVersion,
        )

        if (!subLocation) {
            log(
                LogLevel.WARN,
                `Failed to get location data in CTREE [${contractData.Metadata.Location}]`,
            )
            return []
        }

        const forContract = this.getChallengesForContract(
            contractId,
            gameVersion,
        )
        return this.reBatchIntoSwitchedData(
            forContract,
            userId,
            gameVersion,
            subLocation,
        )
    }

    private mapSwitchChallenges(
        challenges: RegistryChallenge[],
        userId: string,
        gameVersion: GameVersion,
        compiler: Compiler,
    ): CompiledChallengeTreeData[] {
        const progression = getUserData(userId, gameVersion).Extensions
            .ChallengeProgression
        return challenges.map((challengeData) => {
            // Update challenge progression with the user's latest progression data
            if (
                !progression[challengeData.Id].Completed &&
                (challengeData.Definition.Scope === "profile" ||
                    challengeData.Definition.Scope === "hit")
            ) {
                challengeData.Definition.Context =
                    progression[challengeData.Id].State
            }
            const compiled = compiler(
                challengeData,
                this.getPersistentChallengeProgression(
                    userId,
                    challengeData.Id,
                    gameVersion,
                ),
                gameVersion,
                userId,
            )

            compiled.ChallengeProgress = this.getChallengeDependencyData(
                challengeData,
                userId,
                gameVersion,
            )

            return compiled
        })
    }

    private getChallengeDependencyData(
        challengeData: RegistryChallenge,
        userId: string,
        gameVersion: GameVersion,
    ): ChallengeTreeWaterfallState {
        // Handle challenge dependencies
        const dependencies = this.getDependenciesForChallenge(challengeData.Id)
        const completed: string[] = []
        const missing: string[] = []

        let userData: UserProfile | null = null

        if (dependencies.length > 0) {
            userData = getUserData(userId, gameVersion)
        }

        for (const dependency of dependencies) {
            if (this.fastGetIsCompleted(userData!, dependency)) {
                completed.push(dependency)
                continue
            }

            missing.push(dependency)
        }

        const { challengeCountData } =
            ChallengeService._parseContextListeners(challengeData)

        if (dependencies.length > 0) {
            return {
                count: completed.length,
                completed,
                total: dependencies.length,
                missing: missing.length,
                all: dependencies,
            }
        }

        if (challengeCountData.total > 0) {
            return {
                count: challengeCountData.count,
                total: challengeCountData.total,
            }
        }

        return null
    }

    getChallengeDataForDestination(
        locationParentId: string,
        gameVersion: GameVersion,
        userId: string,
    ): CompiledChallengeTreeCategory[] {
        const locationsData = getVersionedConfig<PeacockLocationsData>(
            "LocationsData",
            gameVersion,
            false,
        )

        const locationData = locationsData.parents[locationParentId]

        if (!locationData) {
            log(
                LogLevel.WARN,
                `Failed to get location data in CSERV [${locationParentId}]`,
            )
            return []
        }

        const forLocation = this.getGroupedChallengeLists({
            type: ChallengeFilterType.ParentLocation,
            locationParentId,
        })

        return this.reBatchIntoSwitchedData(
            forLocation,
            userId,
            gameVersion,
            locationData,
            true,
        )
    }

    getChallengeDataForLocation(
        locationId: string,
        gameVersion: GameVersion,
        userId: string,
    ): CompiledChallengeTreeCategory[] {
        const locationsData = getVersionedConfig<PeacockLocationsData>(
            "LocationsData",
            gameVersion,
            false,
        )

        const locationData = locationsData.children[locationId]

        if (!locationData) {
            log(
                LogLevel.WARN,
                `Failed to get location data in CSERV [${locationId}]`,
            )
            return []
        }

        const forLocation = this.getChallengesForLocation(
            locationId,
            gameVersion,
        )

        return this.reBatchIntoSwitchedData(
            forLocation,
            userId,
            gameVersion,
            locationData,
            true,
        )
    }

    private reBatchIntoSwitchedData(
        challengeLists: GroupIndexedChallengeLists,
        userId: string,
        gameVersion: GameVersion,
        subLocation: Unlockable,
        isDestination = false,
    ): CompiledChallengeTreeCategory[] {
        const entries = Object.entries(challengeLists)
        const compiler = isDestination
            ? this.compileRegistryDestinationChallengeData.bind(this)
            : this.compileRegistryChallengeTreeData.bind(this)

        return entries.map(([groupId, challenges], index) => {
            const groupData = this.getGroupById(groupId)
            const challengeProgressionData = challenges.map((challengeData) =>
                this.getPersistentChallengeProgression(
                    userId,
                    challengeData.Id,
                    gameVersion,
                ),
            )

            const lastGroup = this.getGroupById(
                Object.keys(challengeLists)[index - 1],
            )
            const nextGroup = this.getGroupById(
                Object.keys(challengeLists)[index + 1],
            )

            const completion = generateCompletionData(
                subLocation?.Id,
                userId,
                gameVersion,
            )

            return {
                Name: groupData?.Name,
                Description: groupData.Description,
                Image: groupData.Image,
                CategoryId: groupData.CategoryId,
                Icon: groupData.Icon,
                ChallengesCount: challenges.length,
                CompletedChallengesCount: challengeProgressionData.filter(
                    (progressionData) => progressionData.Completed,
                ).length,
                CompletionData: completion,
                Location: subLocation,
                IsLocked: subLocation.Properties.IsLocked || false,
                ImageLocked: subLocation.Properties.LockedIcon || "",
                RequiredResources: subLocation.Properties.RequiredResources!,
                SwitchData: {
                    Data: {
                        Challenges: this.mapSwitchChallenges(
                            challenges,
                            userId,
                            gameVersion,
                            compiler,
                        ),
                        HasPrevious: index !== 0, // whether we are not at the first group
                        HasNext:
                            index !== Object.keys(challengeLists).length - 1, // whether we are not at the final group
                        PreviousCategoryIcon:
                            index !== 0 ? lastGroup?.Icon : "",
                        NextCategoryIcon:
                            index !== Object.keys(challengeLists).length - 1
                                ? nextGroup?.Icon
                                : "",
                        CategoryData: {
                            Name: groupData.Name,
                            Image: groupData.Image,
                            Icon: groupData.Icon,
                            ChallengesCount: challenges.length,
                            CompletedChallengesCount:
                                challengeProgressionData.filter(
                                    (progressionData) =>
                                        progressionData.Completed,
                                ).length,
                        },
                        CompletionData: completion,
                    },
                    IsLeaf: true,
                },
            }
        })
    }

    compileRegistryChallengeTreeData(
        challenge: RegistryChallenge,
        progression: ChallengeProgressionData,
        gameVersion: GameVersion,
        userId: string,
        isDestination = false,
    ): CompiledChallengeTreeData {
        return {
            // GetChallengeTreeFor
            Id: challenge.Id,
            Name: challenge.Name,
            ImageName: challenge.ImageName,
            Description: challenge.Description,
            Rewards: {
                MasteryXP: challenge.Rewards.MasteryXP,
            },
            Drops: [],
            Completed: progression.Completed,
            IsPlayable: isDestination,
            IsLocked: challenge.IsLocked || false,
            HideProgression: false,
            CategoryName:
                this.getGroupById(challenge.inGroup!)?.Name || "NOTFOUND",
            Icon: challenge.Icon,
            LocationId: challenge.LocationId,
            ParentLocationId: challenge.ParentLocationId,
            Type: challenge.Type || "contract",
            ChallengeProgress: this.getChallengeDependencyData(
                challenge,
                userId,
                gameVersion,
            ),
            DifficultyLevels: [],
            CompletionData: generateCompletionData(
                challenge.ParentLocationId,
                userId,
                gameVersion,
            ),
        }
    }

    compileRegistryDestinationChallengeData(
        challenge: RegistryChallenge,
        progression: ChallengeProgressionData,
        gameVersion: GameVersion,
        userId: string,
    ): CompiledChallengeTreeData {
        let contract: MissionManifest | null

        // TODO: Properly get escalation groups for this
        if (challenge.Type === "contract") {
            contract = this.controller.resolveContract(
                challenge.InclusionData?.ContractIds?.[0] || "",
            )

            // This is so we can remove unused data and make it more like official - AF
            const meta = contract?.Metadata
            contract = !contract
                ? null
                : {
                      // The null is for escalations as we cannot currently get groups
                      Data: {
                          Bricks: contract.Data.Bricks,
                          DevOnlyBricks: null,
                          GameChangerReferences:
                              contract.Data.GameChangerReferences || [],
                          GameChangers: contract.Data.GameChangers || [],
                          GameDifficulties:
                              contract.Data.GameDifficulties || [],
                      },
                      Metadata: {
                          CreationTimestamp: null,
                          CreatorUserId: meta.CreatorUserId,
                          DebriefingVideo: meta.DebriefingVideo || "",
                          Description: meta.Description,
                          Drops: meta.Drops || null,
                          Entitlements: meta.Entitlements || [],
                          GroupTitle: meta.GroupTitle || "",
                          Id: meta.Id,
                          IsPublished: meta.IsPublished || true,
                          LastUpdate: null,
                          Location: meta.Location,
                          PublicId: meta.PublicId || "",
                          ScenePath: meta.ScenePath,
                          Subtype: meta.Subtype || "",
                          TileImage: meta.TileImage,
                          Title: meta.Title,
                          Type: meta.Type,
                      },
                  }
        }

        return {
            ...this.compileRegistryChallengeTreeData(
                challenge,
                progression,
                gameVersion,
                userId,
                true, //isDestination
            ),
            UserCentricContract:
                challenge.Type === "contract"
                    ? generateUserCentric(contract, userId, gameVersion)
                    : (null as unknown as undefined),
        }
    }

    /**
     * Counts the number of challenges and completed challenges in a GroupIndexedChallengeLists object.
     * CAUTION: THIS IS SLOW. Use sparingly.
     *
     * @param challengeLists A GroupIndexedChallengeLists object, holding some challenges to be counted
     * @param userId The userId of the user to acquire completion information
     * @param gameVersion The version of the game
     * @returns An object with two properties: ChallengesCount and CompletedChallengesCount.
     */
    countTotalNCompletedChallenges(
        challengeLists: GroupIndexedChallengeLists,
        userId: string,
        gameVersion: GameVersion,
    ): { ChallengesCount: number; CompletedChallengesCount: number } {
        const userData = getUserData(userId, gameVersion)

        userData.Extensions.ChallengeProgression ??= {}

        let challengesCount = 0
        let completedChallengesCount = 0

        for (const groupId in challengeLists) {
            const challenges = challengeLists[groupId]
            const challengeProgressionData = challenges.map((challengeData) =>
                this.fastGetIsCompleted(userData, challengeData.Id),
            )
            challengesCount += challenges.length
            completedChallengesCount += challengeProgressionData.filter(
                (progressionData) => progressionData,
            ).length
        }

        return {
            ChallengesCount: challengesCount,
            CompletedChallengesCount: completedChallengesCount,
        }
    }

    private onChallengeCompleted(
        session: ContractSession,
        challenge: RegistryChallenge,
        waterfallParent?: string,
    ): void {
        if (waterfallParent) {
            log(
                LogLevel.DEBUG,
                `Challenge ${challenge.Id} completed [via ${waterfallParent}]`,
            )
        } else {
            log(LogLevel.DEBUG, `Challenge ${challenge.Id} completed`)
        }

        const userData = getUserData(session.userId, session.gameVersion)

        userData.Extensions.ChallengeProgression ??= {}

        userData.Extensions.ChallengeProgression[challenge.Id] ??= {
            State: {},
            Completed: false,
            Ticked: false,
        }

        userData.Extensions.ChallengeProgression[challenge.Id].Completed = true

        writeUserData(session.userId, session.gameVersion)

        this.hooks.onChallengeCompleted.call(
            session.userId,
            challenge,
            session.gameVersion,
        )

        // find any dependency trees that depend on the challenge
        for (const depTreeId of this._dependencyTree.keys()) {
            const allDeps = this._dependencyTree.get(depTreeId)

            if (depTreeId === challenge.Id) {
                // we're checking the tree of the challenge that was just completed,
                // so we need to skip it, or we'll get an infinite loop and hit
                // the max call stack size
                continue
            }

            assert.ok(allDeps, `No dep tree for ${depTreeId}`)

            if (!allDeps.includes(challenge.Id)) {
                // we don't care about this tree, it doesn't depend on the challenge
                // note: without this check, a race condition can occur where two
                // trees basically bounce back and forth between each other, causing
                // an infinite loop
                continue
            }

            // check if the dependency tree is completed
            const completed = allDeps.every((depId) =>
                this.fastGetIsCompleted(userData, depId),
            )

            if (!completed) {
                continue
            }

            this.onChallengeCompleted(
                session,
                this.getChallengeById(depTreeId),
                challenge.Id,
            )
        }
    }
}
